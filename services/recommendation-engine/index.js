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
const PORT = process.env.RECOMMENDATION_ENGINE_PORT || 3002;

app.use(helmet());
app.use(cors());
app.use(express.json());

const eventBus = new EventBus();

class RecommendationEngine {
  constructor() {
    this.currentModel = null;
    this.modelVersion = 'v1.0';
    this.userProfiles = new Map();
    this.productVectors = new Map();
  }

  // Инициализация базовой модели рекомендаций
  async initializeModel() {
    this.currentModel = {
      version: this.modelVersion,
      type: 'collaborative_filtering',
      weights: {
        view: 1.0,
        add_to_cart: 2.0,
        purchase: 5.0,
        search: 0.5
      },
      timeDecay: 0.9,
      minInteractions: 3
    };
    console.log('Recommendation model initialized:', this.currentModel.version);
  }

  // Обновление модели без остановки сервиса
  async updateModel(newModelData) {
    try {
      console.log('Starting model update...');

      // Создание новой модели в фоновом режиме
      const newModel = {
        version: newModelData.version,
        type: newModelData.type || this.currentModel.type,
        weights: newModelData.weights || this.currentModel.weights,
        timeDecay: newModelData.timeDecay || this.currentModel.timeDecay,
        minInteractions: newModelData.minInteractions || this.currentModel.minInteractions
      };

      // Валидация новой модели
      await this.validateModel(newModel);

      // Атомарное переключение модели
      this.currentModel = newModel;
      this.modelVersion = newModel.version;

      // Публикация события об обновлении модели
      const event = EventFactory.createRecommendationModelUpdated(
        `model-${this.modelVersion}`,
        this.modelVersion,
        { accuracy: 0.85, coverage: 0.92 }
      );

      await eventBus.publish(event);

      console.log(`Model updated successfully to version: ${this.modelVersion}`);
      return { success: true, version: this.modelVersion };
    } catch (error) {
      console.error('Failed to update model:', error);
      return { success: false, error: error.message };
    }
  }

  async validateModel(model) {
    if (!model.weights || typeof model.weights !== 'object') {
      throw new Error('Invalid model weights');
    }
    if (!model.version || typeof model.version !== 'string') {
      throw new Error('Invalid model version');
    }
    // Дополнительная валидация...
  }

  // Генерация рекомендаций для пользователя
  async generateRecommendations(userId, limit = 10) {
    try {
      if (!this.currentModel) {
        await this.initializeModel();
      }

      // Получение профиля поведения пользователя
      const userBehavior = await this.getUserBehavior(userId);
      if (!userBehavior || userBehavior.length < this.currentModel.minInteractions) {
        // Для новых пользователей возвращаем популярные товары
        return this.getPopularProducts(limit);
      }

      // Расчет схожести с другими пользователями (коллаборативная фильтрация)
      const similarUsers = await this.findSimilarUsers(userId, userBehavior);

      // Генерация рекомендаций на основе схожих пользователей
      const recommendations = await this.generateCollaborativeRecommendations(
        userId,
        similarUsers,
        limit
      );

      // Сохранение рекомендаций в базу данных
      await this.saveRecommendations(userId, recommendations);

      // Публикация события о генерации рекомендаций
      const event = EventFactory.createRecommendationGenerated(
        userId,
        recommendations,
        this.modelVersion
      );

      await eventBus.publish(event);

      return {
        success: true,
        userId,
        recommendations,
        modelVersion: this.modelVersion,
        generatedAt: new Date()
      };
    } catch (error) {
      console.error('Error generating recommendations:', error);
      return { success: false, error: error.message };
    }
  }

  async getUserBehavior(userId) {
    const query = `
      SELECT product_id, activity_type, timestamp, activity_data
      FROM user_activities
      WHERE user_id = $1
      ORDER BY timestamp DESC
      LIMIT 100
    `;

    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  async findSimilarUsers(userId, userBehavior, limit = 50) {
    // Упрощенный алгоритм поиска схожих пользователей
    const userProducts = new Set(userBehavior.map(a => a.product_id));

    const query = `
      SELECT DISTINCT user_id, COUNT(*) as common_products
      FROM user_activities
      WHERE product_id = ANY($1)
        AND user_id != $2
        AND timestamp > NOW() - INTERVAL '30 days'
      GROUP BY user_id
      HAVING COUNT(*) >= 2
      ORDER BY common_products DESC
      LIMIT $3
    `;

    const result = await pool.query(query, [Array.from(userProducts), userId, limit]);
    return result.rows;
  }

  async generateCollaborativeRecommendations(userId, similarUsers, limit) {
    if (similarUsers.length === 0) {
      return this.getPopularProducts(limit);
    }

    const similarUserIds = similarUsers.map(u => u.user_id);

    const query = `
      SELECT product_id, COUNT(*) as frequency,
             AVG(CASE WHEN activity_type = 'purchase' THEN 5
                     WHEN activity_type = 'add_to_cart' THEN 3
                     WHEN activity_type = 'view' THEN 1 ELSE 0 END) as score
      FROM user_activities
      WHERE user_id = ANY($1)
        AND product_id NOT IN (
          SELECT product_id FROM user_activities
          WHERE user_id = $2
        )
      GROUP BY product_id
      ORDER BY score DESC, frequency DESC
      LIMIT $3
    `;

    const result = await pool.query(query, [similarUserIds, userId, limit]);

    return result.rows.map(row => ({
      productId: row.product_id,
      score: parseFloat(row.score),
      confidence: Math.min(row.frequency / similarUsers.length, 1.0),
      reason: 'collaborative_filtering'
    }));
  }

  async getPopularProducts(limit = 10) {
    const query = `
      SELECT product_id, COUNT(*) as interaction_count,
             AVG(CASE WHEN activity_type = 'purchase' THEN 5
                     WHEN activity_type = 'add_to_cart' THEN 3
                     WHEN activity_type = 'view' THEN 1 ELSE 0 END) as score
      FROM user_activities
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY product_id
      ORDER BY score DESC, interaction_count DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);

    return result.rows.map(row => ({
      productId: row.product_id,
      score: parseFloat(row.score),
      confidence: 0.5,
      reason: 'popular_products'
    }));
  }

  async saveRecommendations(userId, recommendations) {
    // Очистка старых рекомендаций
    await pool.query('DELETE FROM recommendations WHERE user_id = $1', [userId]);

    // Вставка новых рекомендаций
    const insertQuery = `
      INSERT INTO recommendations (user_id, product_id, score, model_version)
      VALUES ($1, $2, $3, $4)
    `;

    for (const rec of recommendations) {
      await pool.query(insertQuery, [
        userId,
        rec.productId,
        rec.score,
        this.modelVersion
      ]);
    }
  }

  // Обработка событий от других сервисов
  async handleUserActivityEvent(event) {
    const { userId } = event.data;

    // Обновление кэша профиля пользователя при необходимости
    if (this.userProfiles.has(userId)) {
      this.userProfiles.delete(userId);
    }
  }

  async handleModelUpdateEvent(event) {
    console.log('Model update detected:', event.data);
    // Перезагрузка модели при необходимости
  }
}

const recommendationEngine = new RecommendationEngine();

// API Routes
app.post('/recommendations/:userId', async (req, res) => {
  const { userId } = req.params;
  const { limit = 10 } = req.body;

  const result = await recommendationEngine.generateRecommendations(userId, limit);
  res.json(result);
});

app.post('/model/update', async (req, res) => {
  const result = await recommendationEngine.updateModel(req.body);
  res.json(result);
});

app.get('/model/current', (req, res) => {
  res.json({
    version: recommendationEngine.modelVersion,
    model: recommendationEngine.currentModel
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'recommendation-engine',
    modelVersion: recommendationEngine.modelVersion,
    timestamp: new Date().toISOString()
  });
});

async function start() {
  try {
    await eventBus.connect();
    await recommendationEngine.initializeModel();

    // Подписка на события
    await eventBus.subscribe(EVENT_TYPES.USER_VIEWED_PRODUCT,
      (event) => recommendationEngine.handleUserActivityEvent(event));
    await eventBus.subscribe(EVENT_TYPES.USER_ADDED_TO_CART,
      (event) => recommendationEngine.handleUserActivityEvent(event));
    await eventBus.subscribe(EVENT_TYPES.USER_PURCHASED_PRODUCT,
      (event) => recommendationEngine.handleUserActivityEvent(event));
    await eventBus.subscribe(EVENT_TYPES.RECOMMENDATION_MODEL_UPDATED,
      (event) => recommendationEngine.handleModelUpdateEvent(event));

    app.listen(PORT, () => {
      console.log(`Recommendation Engine running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start Recommendation Engine:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down Recommendation Engine...');
  await eventBus.disconnect();
  await pool.end();
  process.exit(0);
});

start();