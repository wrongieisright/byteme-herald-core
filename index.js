const { initSharedSchema, SHARED_TABLES } = require('./db/schema');
const { createSharedQueries } = require('./db/queries');
const { createBotMessages, previewFromContent } = require('./features/botMessages');
const scheduler = require('./features/scheduler');
const { createRedemptionEngine, sleep, nowSeconds, makeSign } = require('./features/redemption');
const { createGiftCodeDetector, labeledCodeRegex, bareLineRegex } = require('./features/giftcodeDetection');
const { createTelegramWatcher } = require('./features/telegramWatcher');
const { createDashboard, registerSharedRoutes } = require('./web/dashboard');

module.exports = {
  // db
  initSharedSchema,
  SHARED_TABLES,
  createSharedQueries,
  // features
  createBotMessages,
  previewFromContent,
  createScheduler: scheduler.createScheduler,
  scheduler,
  createRedemptionEngine,
  sleep,
  nowSeconds,
  makeSign,
  createGiftCodeDetector,
  labeledCodeRegex,
  bareLineRegex,
  createTelegramWatcher,
  // web
  createDashboard,
  registerSharedRoutes
};
