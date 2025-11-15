const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const _ = require('lodash');
const moment = require('moment');
require('dotenv').config();

const EventBus = require('../../shared/eventBus');
const { EventFactory, EVENT_TYPES } = require('../../shared/events');
const { pool } = require('../../config/database');

const app = express();
const PORT = process.env.MODEL_TRAINING_SERVICE_PORT || 3004;

app.use(helmet());
app.use(cors());
app.use(express.json());

const eventBus = new EventBus();

class ModelTrainingService {
  constructor() {
    this.isTraining = false;
    this.trainingQueue = [];
    this.currentTrainingJob = null;
    this.modelVersions = new Map();
  }

  // Запуск обучения новой модели
  async startModelTraining(config = {}) {
    try {
      if (this.isTraining) {
        // Добавляем в очередь если уже идет обучение
        const jobId = this.generateJobId();
        this.trainingQueue.push({
          id: jobId,
          config,
          status: 'queued',
          createdAt: new Date()
        });
        return { success: true, jobId, status: 'queued' };
      }

      const jobId = this.generateJobId();
      this.currentTrainingJob = {
        id: jobId,
        config,
        status: 'started',
        createdAt: new Date()
      };

      this.isTraining = true;

      // Публикация события начала обучения
      const startEvent = {
        type: EVENT_TYPES.MODEL_TRAINING_STARTED,
        data: {
          jobId,
          config,
          timestamp: new Date()
        },
        source: 'model-training'
      };

      await eventBus.publish(startEvent);

      console.log(`Model training started: ${jobId}`);

      // Запуск обучения в фоновом режиме
      this.trainModelAsync(jobId, config);

      return { success: true, jobId, status: 'started' };
    } catch (error) {
      console.error('Failed to start model training:', error);
      return { success: false, error: error.message };
    }
  }

  async trainModelAsync(jobId, config) {
    try {
      console.log(`Training model for job: ${jobId}`);

      // Этап 1: Сбор данных
      const trainingData = await this.collectTrainingData();
      console.log(`Collected ${trainingData.length} training samples`);

      // Этап 2: Предобработка данных
      const processedData = await this.preprocessData(trainingData);

      // Этап 3: Обучение модели
      const model = await this.trainModel(processedData, config);

      // Этап 4: Валидация модели
      const validationResults = await this.validateModel(model, processedData);

      // Этап 5: Сохранение модели
      const modelVersion = await this.saveModel(jobId, model, validationResults, config);

      // Этап 6: Обновление модели в Recommendation Engine (Hot-swap)
      await this.deployModel(modelVersion);

      this.currentTrainingJob.status = 'completed';
      this.currentTrainingJob.completedAt = new Date();

      // Публикация события завершения обучения
      const completeEvent = EventFactory.createRecommendationModelUpdated(
        modelVersion.id,
        modelVersion.version,
        validationResults.metrics
      );

      await eventBus.publish(completeEvent);

      console.log(`Model training completed: ${modelVersion.version}`);

      // Обработка следующей задачи в очереди
      this.processNextInQueue();

    } catch (error) {
      console.error(`Model training failed for job ${jobId}:`, error);

      this.currentTrainingJob.status = 'failed';
      this.currentTrainingJob.error = error.message;

      // Публикация события об ошибке
      const errorEvent = {
        type: 'ModelTrainingFailed',
        data: {
          jobId,
          error: error.message,
          timestamp: new Date()
        },
        source: 'model-training'
      };

      await eventBus.publish(errorEvent);

      this.processNextInQueue();
    }
  }

  // Сбор обучающих данных
  async collectTrainingData() {
    const query = `
      SELECT
        ua.user_id,
        ua.product_id,
        ua.activity_type,
        ua.timestamp,
        p.category,
        p.price,
        -- Получение последующей активности для оценки качества
        LAG(ua.activity_type) OVER (
          PARTITION BY ua.user_id, ua.product_id
          ORDER BY ua.timestamp
        ) as next_activity
      FROM user_activities ua
      JOIN products p ON ua.product_id = p.id
      WHERE ua.timestamp > NOW() - INTERVAL '30 days'
      ORDER BY ua.user_id, ua.timestamp
    `;

    const result = await pool.query(query);
    return result.rows;
  }

  // Предобработка данных
  async preprocessData(data) {
    // Создание пользовательских векторов
    const userVectors = new Map();
    const productVectors = new Map();

    for (const row of data) {
      // Пользовательский вектор на основе активности
      if (!userVectors.has(row.user_id)) {
        userVectors.set(row.user_id, {
          views: new Set(),
          purchases: new Set(),
          cartAdds: new Set(),
          categories: new Map(),
          avgPriceViewed: [],
          lastActivity: null
        });
      }

      const userVec = userVectors.get(row.user_id);

      switch (row.activity_type) {
        case 'view':
          userVec.views.add(row.product_id);
          userVec.avgPriceViewed.push(parseFloat(row.price));
          break;
        case 'purchase':
          userVec.purchases.add(row.product_id);
          break;
        case 'add_to_cart':
          userVec.cartAdds.add(row.product_id);
          break;
      }

      if (row.category) {
        userVec.categories.set(row.category, (userVec.categories.get(row.category) || 0) + 1);
      }

      userVec.lastActivity = row.timestamp;

      // Товарный вектор
      if (!productVectors.has(row.product_id)) {
        productVectors.set(row.product_id, {
          category: row.category,
          price: parseFloat(row.price),
          totalViews: 0,
          totalPurchases: 0,
          totalCartAdds: 0,
          uniqueUsers: new Set()
        });
      }

      const productVec = productVectors.get(row.product_id);
      productVec.uniqueUsers.add(row.user_id);

      switch (row.activity_type) {
        case 'view':
          productVec.totalViews++;
          break;
        case 'purchase':
          productVec.totalPurchases++;
          break;
        case 'add_to_cart':
          productVec.totalCartAdds++;
          break;
      }
    }

    return {
      userVectors,
      productVectors,
      interactions: data
    };
  }

  // Обучение модели
  async trainModel(processedData, config) {
    const { userVectors, productVectors } = processedData;

    // Упрощенная модель коллаборативной фильтрации
    const model = {
      type: 'collaborative_filtering',
      version: this.generateModelVersion(),
      userVectors: new Map(),
      productVectors: new Map(),
      similarityMatrix: new Map(),
      weights: config.weights || {
        view: 1.0,
        add_to_cart: 2.5,
        purchase: 5.0
      },
      timeDecay: config.timeDecay || 0.9,
      trainedAt: new Date()
    };

    // Создание пользовательских профилей
    for (const [userId, userData] of userVectors) {
      const profile = this.createUserProfile(userData, config);
      model.userVectors.set(userId, profile);
    }

    // Создание товарных профилей
    for (const [productId, productData] of productVectors) {
      const profile = this.createProductProfile(productData);
      model.productVectors.set(productId, profile);
    }

    // Расчет матрицы схожести товаров
    model.similarityMatrix = this.calculateSimilarityMatrix(processedData);

    return model;
  }

  createUserProfile(userData, config) {
    const avgPrice = userData.avgPriceViewed.length > 0
      ? userData.avgPriceViewed.reduce((a, b) => a + b) / userData.avgPriceViewed.length
      : 0;

    return {
      viewCount: userData.views.size,
      purchaseCount: userData.purchases.size,
      cartAddCount: userData.cartAdds.size,
      preferredCategories: Array.from(userData.categories.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat]) => cat),
      avgPriceRange: avgPrice,
      lastActivity: userData.lastActivity,
      engagementScore: userData.purchases.size * 5 + userData.cartAdds.size * 2 + userData.views.size
    };
  }

  createProductProfile(productData) {
    return {
      category: productData.category,
      price: productData.price,
      popularityScore: productData.totalViews * 1 + productData.totalCartAdds * 2 + productData.totalPurchases * 5,
      conversionRate: productData.totalViews > 0
        ? productData.totalPurchases / productData.totalViews
        : 0,
      uniqueUsers: productData.uniqueUsers.size
    };
  }

  calculateSimilarityMatrix(processedData) {
    const similarity = new Map();
    const { interactions } = processedData;

    // Группировка взаимодействий по парам товаров
    const coOccurrences = new Map();

    for (const interaction of interactions) {
      // Для каждого пользователя найти другие товары с которыми взаимодействовал
      const userInteractions = interactions.filter(i =>
        i.user_id === interaction.user_id &&
        i.product_id !== interaction.product_id
      );

      for (const otherInteraction of userInteractions) {
        const pair = [interaction.product_id, otherInteraction.product_id].sort().join('-');
        coOccurrences.set(pair, (coOccurrences.get(pair) || 0) + 1);
      }
    }

    // Расчет схожести
    for (const [pair, count] of coOccurrences) {
      if (count > 2) { // Минимальный порог схожести
        const [product1, product2] = pair.split('-');
        similarity.set(`${product1}-${product2}`, count / Math.max(coOccurrences.size, 1));
      }
    }

    return similarity;
  }

  // Валидация модели
  async validateModel(model, processedData) {
    // Разделение данных на обучающую и тестовую выборки
    const { interactions } = processedData;
    const testSize = Math.floor(interactions.length * 0.2);
    const testData = interactions.slice(0, testSize);
    const trainingData = interactions.slice(testSize);

    // Упрощенная валидация - расчет precision@k
    let totalPrecision = 0;
    let testCount = 0;

    for (const testInteraction of testData) {
      if (testInteraction.activity_type === 'purchase') {
        // Получаем рекомендации для этого пользователя
        const recommendations = this.predictRecommendations(
          testInteraction.user_id,
          model,
          10
        );

        // Проверяем, есть ли купленный товар в рекомендациях
        const isRecommended = recommendations.some(r => r.productId === testInteraction.product_id);
        totalPrecision += isRecommended ? 1 : 0;
        testCount++;
      }
    }

    const precision = testCount > 0 ? totalPrecision / testCount : 0;
    const coverage = model.productVectors.size / (model.productVectors.size + testCount);

    return {
      metrics: {
        precision: Math.round(precision * 1000) / 1000,
        coverage: Math.round(coverage * 1000) / 1000,
        modelSize: model.userVectors.size + model.productVectors.size,
        trainingDataSize: trainingData.length,
        testDataSize: testData.length
      },
      valid: precision > 0.1 // Минимальный порог качества
    };
  }

  predictRecommendations(userId, model, limit = 10) {
    const userProfile = model.userVectors.get(userId);
    if (!userProfile) return [];

    const recommendations = [];

    for (const [productId, productProfile] of model.productVectors) {
      // Пропускаем товары с которыми уже взаимодействовал
      if (userProfile.viewCount > 0 && userProfile.preferredCategories.includes(productProfile.category)) {
        const score = this.calculateRecommendationScore(userProfile, productProfile, model);
        recommendations.push({ productId, score });
      }
    }

    return recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  calculateRecommendationScore(userProfile, productProfile, model) {
    let score = 0;

    // Схожесть по категориям
    if (userProfile.preferredCategories.includes(productProfile.category)) {
      score += 0.3;
    }

    // Учет ценового диапазона
    if (Math.abs(productProfile.price - userProfile.avgPriceRange) / userProfile.avgPriceRange < 0.5) {
      score += 0.2;
    }

    // Популярность товара
    score += Math.min(productProfile.popularityScore / 100, 0.3);

    // Конверсия товара
    score += productProfile.conversionRate * 0.2;

    return score;
  }

  // Сохранение модели
  async saveModel(jobId, model, validationResults, config) {
    const modelId = this.generateModelId();
    const version = model.version;

    const query = `
      INSERT INTO recommendation_models (id, version, model_data, metrics, status)
      VALUES ($1, $2, $3, $4, 'completed')
      RETURNING *
    `;

    const result = await pool.query(query, [
      modelId,
      version,
      JSON.stringify(model),
      JSON.stringify(validationResults.metrics)
    ]);

    this.modelVersions.set(version, {
      id: modelId,
      version,
      model,
      metrics: validationResults.metrics,
      createdAt: new Date()
    });

    console.log(`Model saved: ${version} (ID: ${modelId})`);

    return result.rows[0];
  }

  // Развертывание модели (Hot-swap)
  async deployModel(modelVersion) {
    try {
      // Отправка новой модели в Recommendation Engine
      const axios = require('axios');
      const RECOMMENDATION_ENGINE_URL = process.env.RECOMMENDATION_ENGINE_URL || 'http://localhost:3002';

      const modelData = {
        version: modelVersion.version,
        type: 'collaborative_filtering',
        weights: this.currentTrainingJob?.config?.weights || {
          view: 1.0,
          add_to_cart: 2.5,
          purchase: 5.0
        },
        timeDecay: this.currentTrainingJob?.config?.timeDecay || 0.9,
        minInteractions: 3
      };

      await axios.post(`${RECOMMENDATION_ENGINE_URL}/model/update`, modelData);

      console.log(`Model deployed: ${modelVersion.version}`);
      return { success: true, version: modelVersion.version };
    } catch (error) {
      console.error('Failed to deploy model:', error);
      return { success: false, error: error.message };
    }
  }

  // Обработка очереди
  processNextInQueue() {
    this.isTraining = false;
    this.currentTrainingJob = null;

    if (this.trainingQueue.length > 0) {
      const nextJob = this.trainingQueue.shift();
      this.startModelTraining(nextJob.config);
    }
  }

  generateJobId() {
    return `job-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  generateModelId() {
    return `model-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }

  generateModelVersion() {
    const timestamp = Date.now();
    const versionNum = this.modelVersions.size + 1;
    return `v${versionNum}.${timestamp}`;
  }

  // Получение статуса обучения
  getTrainingStatus() {
    return {
      isTraining: this.isTraining,
      currentJob: this.currentTrainingJob,
      queueLength: this.trainingQueue.length,
      completedModels: this.modelVersions.size
    };
  }

  // Получение списка моделей
  async getModelVersions() {
    try {
      const query = `
        SELECT * FROM recommendation_models
        ORDER BY created_at DESC
      `;

      const result = await pool.query(query);
      return { success: true, models: result.rows };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

const modelTrainingService = new ModelTrainingService();

// API Routes
app.post('/train', async (req, res) => {
  const { config } = req.body;
  const result = await modelTrainingService.startModelTraining(config);
  res.json(result);
});

app.get('/status', (req, res) => {
  const status = modelTrainingService.getTrainingStatus();
  res.json({ success: true, status });
});

app.get('/models', async (req, res) => {
  const result = await modelTrainingService.getModelVersions();
  res.json(result);
});

app.get('/health', (req, res) => {
  const status = modelTrainingService.getTrainingStatus();
  res.json({
    status: 'healthy',
    service: 'model-training-service',
    ...status,
    timestamp: new Date().toISOString()
  });
});

async function start() {
  try {
    await eventBus.connect();

    // Запуск периодического обучения моделей
    setInterval(async () => {
      if (!modelTrainingService.isTraining && modelTrainingService.trainingQueue.length === 0) {
        console.log('Starting scheduled model training...');
        await modelTrainingService.startModelTraining({
          weights: { view: 1.0, add_to_cart: 2.5, purchase: 5.0 },
          timeDecay: 0.9
        });
      }
    }, 60 * 60 * 1000); // Каждый час

    app.listen(PORT, () => {
      console.log(`Model Training Service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start Model Training Service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down Model Training Service...');
  await eventBus.disconnect();
  await pool.end();
  process.exit(0);
});

start();