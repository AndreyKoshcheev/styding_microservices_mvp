// Определение событий системы на основе Event Storming

const EVENT_TYPES = {
  // События действий пользователей
  USER_VIEWED_PRODUCT: 'UserViewedProduct',
  USER_ADDED_TO_CART: 'UserAddedToCart',
  USER_PURCHASED_PRODUCT: 'UserPurchasedProduct',
  USER_SEARCHED_PRODUCTS: 'UserSearchedProducts',

  // События рекомендаций
  RECOMMENDATION_GENERATED: 'RecommendationGenerated',
  RECOMMENDATION_MODEL_UPDATED: 'RecommendationModelUpdated',

  // Системные события
  MODEL_TRAINING_STARTED: 'ModelTrainingStarted'
};

class Event {
  constructor(type, data, aggregateId, timestamp = new Date()) {
    this.type = type;
    this.data = data;
    this.aggregateId = aggregateId;
    this.timestamp = timestamp;
    this.id = this.generateId();
  }

  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      data: this.data,
      aggregateId: this.aggregateId,
      timestamp: this.timestamp instanceof Date ? this.timestamp.toISOString() : this.timestamp
    };
  }

  static fromJSON(json) {
    const event = new Event(json.type, json.data, json.aggregateId, new Date(json.timestamp));
    event.id = json.id;
    return event;
  }
}

// Фабрики для создания специфических событий
class EventFactory {
  static createUserViewedProduct(userId, productId, metadata = {}) {
    return new Event(EVENT_TYPES.USER_VIEWED_PRODUCT, {
      userId,
      productId,
      timestamp: new Date(),
      metadata
    }, `user-${userId}`);
  }

  static createUserAddedToCart(userId, productId, quantity = 1, metadata = {}) {
    return new Event(EVENT_TYPES.USER_ADDED_TO_CART, {
      userId,
      productId,
      quantity,
      timestamp: new Date(),
      metadata
    }, `user-${userId}`);
  }

  static createUserPurchasedProduct(userId, productId, quantity, price, metadata = {}) {
    return new Event(EVENT_TYPES.USER_PURCHASED_PRODUCT, {
      userId,
      productId,
      quantity,
      price,
      timestamp: new Date(),
      metadata
    }, `user-${userId}`);
  }

  static createUserSearchedProducts(userId, query, results, metadata = {}) {
    return new Event(EVENT_TYPES.USER_SEARCHED_PRODUCTS, {
      userId,
      query,
      results,
      timestamp: new Date(),
      metadata
    }, `user-${userId}`);
  }

  static createRecommendationGenerated(userId, recommendations, model, metadata = {}) {
    return new Event(EVENT_TYPES.RECOMMENDATION_GENERATED, {
      userId,
      recommendations,
      model,
      timestamp: new Date(),
      metadata
    }, `user-${userId}`);
  }

  static createRecommendationModelUpdated(modelId, version, metrics, metadata = {}) {
    return new Event(EVENT_TYPES.RECOMMENDATION_MODEL_UPDATED, {
      modelId,
      version,
      metrics,
      timestamp: new Date(),
      metadata
    }, 'model-training');
  }
}

module.exports = {
  Event,
  EventFactory,
  EVENT_TYPES
};