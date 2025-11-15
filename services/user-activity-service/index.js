const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const EventBus = require('../../shared/eventBus');
const { EventFactory, EVENT_TYPES } = require('../../shared/events');
const { pool } = require('../../config/database');
const { checkAndInitialize } = require('../../scripts/init-database');

const app = express();
const PORT = process.env.USER_ACTIVITY_SERVICE_PORT || 3001;

app.use(helmet());
app.use(cors());
app.use(express.json());

const eventBus = new EventBus();

class UserActivityService {
  constructor() {
    this.activities = new Map();
  }

  async trackUserActivity(activityData) {
    const { userId, productId, activityType, metadata = {} } = activityData;

    try {
      // Сохранение активности в базу данных
      const query = `
        INSERT INTO user_activities (user_id, product_id, activity_type, activity_data, timestamp)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        RETURNING id
      `;

      const result = await pool.query(query, [userId, productId, activityType, metadata]);

      // Публикация события в EventBus
      let event;
      switch (activityType) {
        case 'view':
          event = EventFactory.createUserViewedProduct(userId, productId, metadata);
          break;
        case 'add_to_cart':
          event = EventFactory.createUserAddedToCart(userId, productId, metadata.quantity || 1, metadata);
          break;
        case 'purchase':
          event = EventFactory.createUserPurchasedProduct(userId, productId, metadata.quantity, metadata.price, metadata);
          break;
        case 'search':
          event = EventFactory.createUserSearchedProducts(userId, metadata.query, metadata.results, metadata);
          break;
        default:
          console.warn(`Unknown activity type: ${activityType}`);
          return { success: false, error: 'Unknown activity type' };
      }

      await eventBus.publish(event);

      console.log(`Activity tracked: ${activityType} for user ${userId}`);
      return {
        success: true,
        activityId: result.rows[0].id,
        eventId: event.id
      };
    } catch (error) {
      console.error('Error tracking user activity:', error);
      return { success: false, error: error.message };
    }
  }

  async getUserActivities(userId, limit = 100) {
    try {
      const query = `
        SELECT * FROM user_activities
        WHERE user_id = $1
        ORDER BY timestamp DESC
        LIMIT $2
      `;

      const result = await pool.query(query, [userId, limit]);
      return { success: true, activities: result.rows };
    } catch (error) {
      console.error('Error getting user activities:', error);
      return { success: false, error: error.message };
    }
  }

  async getUserBehaviorProfile(userId) {
    try {
      const query = `
        SELECT
          activity_type,
          COUNT(*) as count,
          AVG(CASE WHEN activity_type = 'purchase' THEN (activity_data->>'price')::decimal END) as avg_purchase_value
        FROM user_activities
        WHERE user_id = $1
          AND timestamp > NOW() - INTERVAL '30 days'
        GROUP BY activity_type
      `;

      const result = await pool.query(query, [userId]);

      // Получение последних просмотренных товаров
      const recentViewsQuery = `
        SELECT product_id, COUNT(*) as view_count
        FROM user_activities
        WHERE user_id = $1 AND activity_type = 'view'
          AND timestamp > NOW() - INTERVAL '7 days'
        GROUP BY product_id
        ORDER BY view_count DESC
        LIMIT 10
      `;

      const recentViews = await pool.query(recentViewsQuery, [userId]);

      return {
        success: true,
        profile: {
          summary: result.rows,
          recentlyViewed: recentViews.rows
        }
      };
    } catch (error) {
      console.error('Error getting user behavior profile:', error);
      return { success: false, error: error.message };
    }
  }
}

const userActivityService = new UserActivityService();

// API Routes
app.post('/track', async (req, res) => {
  const result = await userActivityService.trackUserActivity(req.body);
  res.json(result);
});

app.get('/activities/:userId', async (req, res) => {
  const { userId } = req.params;
  const { limit = 100 } = req.query;

  const result = await userActivityService.getUserActivities(userId, parseInt(limit));
  res.json(result);
});

app.get('/profile/:userId', async (req, res) => {
  const { userId } = req.params;

  const result = await userActivityService.getUserBehaviorProfile(userId);
  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'user-activity-service',
    timestamp: new Date().toISOString()
  });
});

async function start() {
  try {
    // Инициализация базы данных при первом запуске
    console.log('🔍 Checking database status...');
    await checkAndInitialize();

    await eventBus.connect();

    app.listen(PORT, () => {
      console.log(`User Activity Service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start User Activity Service:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down User Activity Service...');
  await eventBus.disconnect();
  await pool.end();
  process.exit(0);
});

start();