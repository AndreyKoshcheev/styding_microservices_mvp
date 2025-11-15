-- Инициализация базы данных системы рекомендаций
-- Создание таблиц

-- Пользователи
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(255) PRIMARY KEY,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Товары
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(500) NOT NULL,
  category VARCHAR(100),
  price DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Активности пользователей
CREATE TABLE IF NOT EXISTS user_activities (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  product_id VARCHAR(255),
  activity_type VARCHAR(50) NOT NULL,
  activity_data JSONB,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Рекомендации
CREATE TABLE IF NOT EXISTS recommendations (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  score DECIMAL(5,4) NOT NULL,
  model_version VARCHAR(50),
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Модели рекомендаций
CREATE TABLE IF NOT EXISTS recommendation_models (
  id VARCHAR(255) PRIMARY KEY,
  version VARCHAR(50) NOT NULL,
  model_data JSONB,
  metrics JSONB,
  status VARCHAR(20) DEFAULT 'training',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deployed_at TIMESTAMP
);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_user_activities_user_id ON user_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activities_timestamp ON user_activities(timestamp);
CREATE INDEX IF NOT EXISTS idx_recommendations_user_id ON recommendations(user_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_score ON recommendations(score DESC);

-- Вставка демо-данных

-- Пользователи
INSERT INTO users (id) VALUES
  ('user-1'), ('user-2'), ('user-3'), ('user-4'), ('user-5')
ON CONFLICT (id) DO NOTHING;

-- Товары
INSERT INTO products (id, name, category, price) VALUES
  ('product-1', 'Смартфон Galaxy A53', 'Электроника', 29999.00),
  ('product-2', 'Наушники Bluetooth Sony', 'Электроника', 8999.00),
  ('product-3', 'Ноутбук Lenovo IdeaPad', 'Электроника', 45999.00),
  ('product-4', 'Кофемашина Nespresso', 'Бытовая техника', 12999.00),
  ('product-5', 'Фитнес-браслет Xiaomi Mi Band', 'Электроника', 2999.00),
  ('product-6', 'Умные часы Apple Watch', 'Электроника', 35999.00),
  ('product-7', 'Книга "Искусственный интеллект"', 'Книги', 899.00),
  ('product-8', 'Рюкзак для ноутбука', 'Аксессуары', 2499.00),
  ('product-9', 'Внешний SSD 1TB', 'Электроника', 7999.00),
  ('product-10', 'Планшет iPad', 'Электроника', 39999.00)
ON CONFLICT (id) DO NOTHING;