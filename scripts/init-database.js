const { pool, initializeDatabase } = require('../config/database');

async function initializeDatabaseWithDemoData() {
  try {
    console.log('Starting database initialization...');

    // 1. Создание таблиц
    await initializeDatabase();
    console.log('✓ Database tables created successfully');

    // 2. Вставка демо-данных
    await insertDemoData();
    console.log('✓ Demo data inserted successfully');

    console.log('🎉 Database initialization completed!');

  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }
}

async function insertDemoData() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Вставка пользователей
    await client.query(`
      INSERT INTO users (id) VALUES
        ('user-1'), ('user-2'), ('user-3'), ('user-4'), ('user-5')
      ON CONFLICT (id) DO NOTHING
    `);

    // Вставка товаров
    await client.query(`
      INSERT INTO products (id, name, category, price) VALUES
        ('product-1', 'Смартфон Galaxy A53', 'Электроника', 29999.00),
        ('product-2', 'Наушники Bluetooth Sony', 'Электроника', 8999.00),
        ('product-3', 'Ноутбук Lenovo IdeaPad', 'Электроника', 45999.00),
        ('product-4', 'Кофемашина Nespresso', 'Бытовая техника', 12999.00),
        ('product-5', 'Фитнес-б Xiaomi Mi Band', 'Электроника', 2999.00),
        ('product-6', 'Умные часы Apple Watch', 'Электроника', 35999.00),
        ('product-7', 'Книга "Искусственный интеллект"', 'Книги', 899.00),
        ('product-8', 'Рюкзак для ноутбука', 'Аксессуары', 2499.00),
        ('product-9', 'Внешний SSD 1TB', 'Электроника', 7999.00),
        ('product-10', 'Планшет iPad', 'Электроника', 39999.00)
      ON CONFLICT (id) DO NOTHING
    `);

    // Вставка тестовых активностей пользователей
    await client.query(`
      INSERT INTO user_activities (user_id, product_id, activity_type, activity_data, timestamp) VALUES
        -- Пользователь 1 - интересуется электроникой
        ('user-1', 'product-1', 'view', '{"source": "search", "duration": 45}', NOW() - INTERVAL '2 days'),
        ('user-1', 'product-1', 'add_to_cart', '{"quantity": 1}', NOW() - INTERVAL '2 days'),
        ('user-1', 'product-2', 'view', '{"source": "recommendation", "duration": 30}', NOW() - INTERVAL '1 day'),
        ('user-1', 'product-6', 'view', '{"source": "search", "duration": 60}', NOW() - INTERVAL '3 hours'),
        ('user-1', 'product-5', 'purchase', '{"quantity": 1, "price": 2999.00}', NOW() - INTERVAL '5 days'),

        -- Пользователь 2 - интересуется бытовой техникой
        ('user-2', 'product-4', 'view', '{"source": "category", "duration": 120}', NOW() - INTERVAL '1 day'),
        ('user-2', 'product-4', 'add_to_cart', '{"quantity": 1}', NOW() - INTERVAL '1 day'),
        ('user-2', 'product-4', 'purchase', '{"quantity": 1, "price": 12999.00}', NOW() - INTERVAL '12 hours'),
        ('user-2', 'product-7', 'view', '{"source": "search", "duration": 90}', NOW() - INTERVAL '3 days'),

        -- Пользователь 3 - интересуется аксессуарами
        ('user-3', 'product-8', 'view', '{"source": "search", "duration": 45}', NOW() - INTERVAL '2 days'),
        ('user-3', 'product-8', 'add_to_cart', '{"quantity": 1}', NOW() - INTERVAL '2 days'),
        ('user-3', 'product-2', 'view', '{"source": "recommendation", "duration": 30}', NOW() - INTERVAL '1 day'),
        ('user-3', 'product-5', 'view', '{"source": "popular", "duration": 25}', NOW() - INTERVAL '6 hours'),

        -- Пользователь 4 - разные интересы
        ('user-4', 'product-3', 'view', '{"source": "search", "duration": 180}', NOW() - INTERVAL '4 days'),
        ('user-4', 'product-10', 'view', '{"source": "comparison", "duration": 150}', NOW() - INTERVAL '4 days'),
        ('user-4', 'product-10', 'add_to_cart', '{"quantity": 1}', NOW() - INTERVAL '3 days'),
        ('user-4', 'product-7', 'view', '{"source": "search", "duration": 60}', NOW() - INTERVAL '2 days'),
        ('user-4', 'product-9', 'view', '{"source": "accessory", "duration": 40}', NOW() - INTERVAL '1 day'),

        -- Пользователь 5 - новый пользователь с минимум активностей
        ('user-5', 'product-1', 'view', '{"source": "homepage", "duration": 30}', NOW() - INTERVAL '3 hours')
      ON CONFLICT DO NOTHING
    `);

    // Вставка базовой модели рекомендаций
    await client.query(`
      INSERT INTO recommendation_models (id, version, model_data, metrics, status, deployed_at) VALUES
        ('model-base', 'v1.0',
         '{"type": "collaborative_filtering", "weights": {"view": 1.0, "add_to_cart": 2.0, "purchase": 5.0}}',
         '{"accuracy": 0.75, "coverage": 0.80}',
         'deployed', NOW())
      ON CONFLICT (id) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✓ All demo data inserted successfully');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Проверка, нужно ли инициализировать базу данных
async function checkAndInitialize() {
  try {
    // Проверяем существует ли таблица users
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'users'
      )
    `);

    const needsInitialization = !result.rows[0].exists;

    if (needsInitialization) {
      console.log('📋 Database is empty, starting initialization...');
      await initializeDatabaseWithDemoData();
    } else {
      console.log('✅ Database already initialized');
    }

  } catch (error) {
    console.error('Error checking database status:', error);
    throw error;
  }
}

// Запуск инициализации
if (require.main === module) {
  checkAndInitialize()
    .then(() => {
      console.log('Database setup completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Database setup failed:', error);
      process.exit(1);
    });
}

module.exports = {
  initializeDatabaseWithDemoData,
  checkAndInitialize
};