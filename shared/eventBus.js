const redis = require('redis');
const { Event } = require('./events');

class EventBus {
  constructor() {
    this.publisher = null;
    this.subscribers = new Map();
    this.connected = false;
  }

  async connect() {
    try {
      const redisUrl = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
      console.log('Connecting to Redis at:', redisUrl);

      this.publisher = redis.createClient({
        url: redisUrl
      });

      await this.publisher.connect();
      this.connected = true;
      console.log('EventBus connected to Redis');
    } catch (error) {
      console.error('Failed to connect EventBus to Redis:', error);
      throw error;
    }
  }

  async publish(event) {
    if (!this.connected) {
      throw new Error('EventBus not connected');
    }

    try {
      const channel = `events:${event.type}`;
      const message = JSON.stringify(event.toJSON());

      await this.publisher.publish(channel, message);
      console.log(`Event published: ${event.type} to channel: ${channel}`);
    } catch (error) {
      console.error('Failed to publish event:', error);
      throw error;
    }
  }

  async subscribe(eventType, handler) {
    if (!this.connected) {
      throw new Error('EventBus not connected');
    }

    try {
      const redisUrl = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
      const subscriber = redis.createClient({
        url: redisUrl
      });

      await subscriber.connect();

      const channel = `events:${eventType}`;
      await subscriber.subscribe(channel, (message) => {
        try {
          const eventData = JSON.parse(message);
          const event = Event.fromJSON(eventData);
          handler(event);
        } catch (error) {
          console.error('Failed to process event:', error);
        }
      });

      this.subscribers.set(eventType, subscriber);
      console.log(`Subscribed to channel: ${channel}`);
    } catch (error) {
      console.error('Failed to subscribe to event:', error);
      throw error;
    }
  }

  async unsubscribe(eventType) {
    if (this.subscribers.has(eventType)) {
      const subscriber = this.subscribers.get(eventType);
      await subscriber.quit();
      this.subscribers.delete(eventType);
      console.log(`Unsubscribed from: ${eventType}`);
    }
  }

  async disconnect() {
    for (const [eventType, subscriber] of this.subscribers) {
      await subscriber.quit();
    }
    this.subscribers.clear();

    if (this.publisher) {
      await this.publisher.quit();
    }
    this.connected = false;
    console.log('EventBus disconnected');
  }
}

module.exports = EventBus;