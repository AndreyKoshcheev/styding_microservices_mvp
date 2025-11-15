const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
require('dotenv').config();

const EventBus = require('../../shared/eventBus');
const { EventFactory, EVENT_TYPES } = require('../../shared/events');
const { pool } = require('../../config/database');

const app = express();
const PORT = process.env.RECOMMENDATION_API_PORT || 3003;

app.use(helmet());
app.use(cors());
app.use(express.json());

const eventBus = new EventBus();

// Конфигурация адресов других сервисов
const USER_ACTIVITY_SERVICE_URL = process.env.USER_ACTIVITY_SERVICE_URL || 'http://localhost:3001';
const RECOMMENDATION_ENGINE_URL = process.env.RECOMMENDATION_ENGINE_URL || 'http://localhost:3002';

class RecommendationAPI {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 минут
  }

  // Получение рекомендаций для пользователя
  async getRecommendations(userId, limit = 10, forceRefresh = false) {
    try {
      // Проверка кэша
      const cacheKey = `recommendations:${userId}:${limit}`;
      if (!forceRefresh && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          console.log(`Returning cached recommendations for user ${userId}`);
          return cached.data;
        }
      }

      // Попытка получить существующие рекомендации из базы
      let recommendations = await this.getStoredRecommendations(userId, limit);

      if (!recommendations || recommendations.length === 0 || forceRefresh) {
        // Генерация новых рекомендаций
        const response = await axios.post(
          `${RECOMMENDATION_ENGINE_URL}/recommendations/${userId}`,
          { limit }
        );

        if (response.data.success) {
          recommendations = response.data.recommendations;
        } else {
          throw new Error(response.data.error || 'Failed to generate recommendations');
        }
      }

      // Получение информации о товарах
      const enrichedRecommendations = await this.enrichRecommendations(recommendations);

      const result = {
        success: true,
        userId,
        recommendations: enrichedRecommendations,
        generatedAt: new Date(),
        fromCache: false
      };

      // Кэширование результата
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      // Публикация события доставки рекомендаций
      const event = EventFactory.createRecommendationGenerated(
        userId,
        enrichedRecommendations,
        'api-delivery'
      );
      await eventBus.publish(event);

      return result;
    } catch (error) {
      console.error('Error getting recommendations:', error);
      return {
        success: false,
        error: error.message,
        userId,
        recommendations: []
      };
    }
  }

  async getStoredRecommendations(userId, limit) {
    const query = `
      SELECT r.*, p.name, p.category, p.price
      FROM recommendations r
      JOIN products p ON r.product_id = p.id
      WHERE r.user_id = $1
      ORDER BY r.score DESC
      LIMIT $2
    `;

    const result = await pool.query(query, [userId, limit]);
    return result.rows.map(row => ({
      productId: row.product_id,
      score: parseFloat(row.score),
      confidence: 0.8,
      reason: 'cached_recommendation',
      product: {
        id: row.product_id,
        name: row.name,
        category: row.category,
        price: parseFloat(row.price)
      }
    }));
  }

  async enrichRecommendations(recommendations) {
    if (recommendations.length === 0) return [];

    const productIds = recommendations.map(r => r.productId);

    // Запрос информации о товарах
    const query = `
      SELECT id, name, category, price
      FROM products
      WHERE id = ANY($1)
    `;

    const result = await pool.query(query, [productIds]);
    const products = new Map(result.rows.map(p => [p.id, p]));

    return recommendations.map(rec => ({
      ...rec,
      product: products.get(rec.productId) || {
        id: rec.productId,
        name: 'Unknown Product',
        category: 'Unknown',
        price: 0
      }
    }));
  }

  // Отслеживание действий пользователя
  async trackActivity(userId, activityData) {
    try {
      const response = await axios.post(
        `${USER_ACTIVITY_SERVICE_URL}/track`,
        {
          userId,
          ...activityData
        }
      );

      // Инвалидация кэша рекомендаций для этого пользователя
      this.invalidateUserCache(userId);

      return response.data;
    } catch (error) {
      console.error('Error tracking activity:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  invalidateUserCache(userId) {
    for (const [key, value] of this.cache) {
      if (key.startsWith(`recommendations:${userId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  // Получение статистики рекомендаций
  async getRecommendationStats(userId, days = 7) {
    try {
      const query = `
        SELECT
          COUNT(*) as total_recommendations,
          AVG(score) as avg_score,
          COUNT(CASE WHEN delivered_at IS NOT NULL THEN 1 END) as delivered_count,
          model_version
        FROM recommendations
        WHERE user_id = $1
          AND generated_at > NOW() - INTERVAL '${days} days'
        GROUP BY model_version
        ORDER BY generated_at DESC
        LIMIT 1
      `;

      const result = await pool.query(query, [userId]);

      if (result.rows.length === 0) {
        return {
          success: true,
          stats: {
            totalRecommendations: 0,
            averageScore: 0,
            deliveredCount: 0,
            modelVersion: 'N/A'
          }
        };
      }

      return {
        success: true,
        stats: {
          totalRecommendations: parseInt(result.rows[0].total_recommendations),
          averageScore: parseFloat(result.rows[0].avg_score),
          deliveredCount: parseInt(result.rows[0].delivered_count),
          modelVersion: result.rows[0].model_version
        }
      };
    } catch (error) {
      console.error('Error getting recommendation stats:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Получение истории активностей пользователя
  async getUserActivityHistory(userId, limit = 50) {
    try {
      const response = await axios.get(
        `${USER_ACTIVITY_SERVICE_URL}/activities/${userId}?limit=${limit}`
      );

      return response.data;
    } catch (error) {
      console.error('Error getting user activity history:', error);
      return {
        success: false,
        error: error.message,
        activities: []
      };
    }
  }

  // Обработка событий
  async handleRecommendationGeneratedEvent(event) {
    const { userId } = event.data;
    // Инвалидация кэша при генерации новых рекомендаций
    this.invalidateUserCache(userId);
    console.log(`Cache invalidated for user ${userId} due to new recommendations`);
  }

  handleUserActivityEvent(event) {
    const { userId } = event.data;
    // Инвалидация кэша при новой активности пользователя
    this.invalidateUserCache(userId);
    console.log(`Cache invalidated for user ${userId} due to new activity`);
  }
}

const recommendationAPI = new RecommendationAPI();

// API Routes
app.get('/recommendations/:userId', async (req, res) => {
  const { userId } = req.params;
  const { limit = 10, refresh = 'false' } = req.query;

  const result = await recommendationAPI.getRecommendations(
    userId,
    parseInt(limit),
    refresh === 'true'
  );

  res.json(result);
});

app.post('/track', async (req, res) => {
  const { userId, activityType, productId, metadata = {} } = req.body;

  if (!userId || !activityType) {
    return res.status(400).json({
      success: false,
      error: 'userId and activityType are required'
    });
  }

  const result = await recommendationAPI.trackActivity(userId, {
    activityType,
    productId,
    metadata
  });

  res.json(result);
});

app.get('/stats/:userId', async (req, res) => {
  const { userId } = req.params;
  const { days = 7 } = req.query;

  const result = await recommendationAPI.getRecommendationStats(userId, parseInt(days));
  res.json(result);
});

app.get('/activity/:userId', async (req, res) => {
  const { userId } = req.params;
  const { limit = 50 } = req.query;

  const result = await recommendationAPI.getUserActivityHistory(userId, parseInt(limit));
  res.json(result);
});

app.post('/recommendations/:userId/refresh', async (req, res) => {
  const { userId } = req.params;
  const { limit = 10 } = req.body;

  const result = await recommendationAPI.getRecommendations(
    userId,
    limit,
    true // force refresh
  );

  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'recommendation-api',
    cacheSize: recommendationAPI.cache.size,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('API Error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

async function start() {
  try {
    await eventBus.connect();

    // Подписка на события
    await eventBus.subscribe(EVENT_TYPES.RECOMMENDATION_GENERATED,
      (event) => recommendationAPI.handleRecommendationGeneratedEvent(event));
    await eventBus.subscribe(EVENT_TYPES.USER_VIEWED_PRODUCT,
      (event) => recommendationAPI.handleUserActivityEvent(event));
    await eventBus.subscribe(EVENT_TYPES.USER_ADDED_TO_CART,
      (event) => recommendationAPI.handleUserActivityEvent(event));
    await eventBus.subscribe(EVENT_TYPES.USER_PURCHASED_PRODUCT,
      (event) => recommendationAPI.handleUserActivityEvent(event));

    app.listen(PORT, () => {
      console.log(`Recommendation API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start Recommendation API:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down Recommendation API...');
  await eventBus.disconnect();
  await pool.end();
  process.exit(0);
});

start();