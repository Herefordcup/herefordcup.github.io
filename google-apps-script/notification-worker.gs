const CONFIG_KEYS = Object.freeze({
  functionUrl: 'SUPABASE_NOTIFICATION_FUNCTION_URL',
  workerSecret: 'NOTIFICATION_WORKER_SECRET',
  sentDeliveryIds: 'SENT_DELIVERY_IDS',
});
const SENT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SENT_CACHE_SIZE = 100;

function notificationConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const functionUrl = properties.getProperty(CONFIG_KEYS.functionUrl);
  const workerSecret = properties.getProperty(CONFIG_KEYS.workerSecret);
  if (!functionUrl || !workerSecret) {
    throw new Error('Add SUPABASE_NOTIFICATION_FUNCTION_URL and NOTIFICATION_WORKER_SECRET in Project Settings > Script properties.');
  }
  return { properties, functionUrl, workerSecret };
}

function callNotificationFunction_(config, payload) {
  const response = UrlFetchApp.fetch(config.functionUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-notification-secret': config.workerSecret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  let parsed;
  try {
    parsed = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(`Notification service returned an unreadable response (${status}).`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(parsed.error || `Notification service failed (${status}).`);
  }
  return parsed;
}

function sentDeliveryIds_(properties) {
  const now = Date.now();
  let sentDeliveryIds = {};
  try {
    sentDeliveryIds = JSON.parse(properties.getProperty(CONFIG_KEYS.sentDeliveryIds) || '{}');
  } catch (error) {
    sentDeliveryIds = {};
  }
  Object.keys(sentDeliveryIds).forEach(deliveryId => {
    if (!Number.isFinite(sentDeliveryIds[deliveryId]) || now - sentDeliveryIds[deliveryId] > SENT_CACHE_TTL_MS) {
      delete sentDeliveryIds[deliveryId];
    }
  });
  return Object.fromEntries(Object.entries(sentDeliveryIds)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_SENT_CACHE_SIZE));
}

function saveSentDeliveryIds_(properties, sentDeliveryIds) {
  const bounded = Object.fromEntries(Object.entries(sentDeliveryIds)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_SENT_CACHE_SIZE));
  properties.setProperty(CONFIG_KEYS.sentDeliveryIds, JSON.stringify(bounded));
}

function runNotificationWorker() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const config = notificationConfig_();
    let remainingQuota = MailApp.getRemainingDailyQuota();
    if (remainingQuota < 1) return;
    const claimed = callNotificationFunction_(config, { action: 'claim', limit: Math.min(20, remainingQuota) });
    const messages = Array.isArray(claimed.messages) ? claimed.messages : [];
    if (!messages.length) return;

    const sentDeliveryIds = sentDeliveryIds_(config.properties);
    const results = [];

    for (const message of messages) {
      const deliveryId = String(message.delivery_id || '');
      if (!deliveryId) continue;
      if (sentDeliveryIds[deliveryId]) {
        results.push({ delivery_id: deliveryId, status: 'sent' });
        continue;
      }
      if (remainingQuota < 1) break;

      try {
        const to = String(message.to || '').trim();
        const subject = String(message.subject || '').slice(0, 160);
        const body = String(message.body || '').slice(0, 4000);
        if (!to || !subject || !body) throw new Error('Notification message is incomplete.');
        MailApp.sendEmail({ to, subject, body, name: 'Hereford Cup' });
        remainingQuota -= 1;
        sentDeliveryIds[deliveryId] = Date.now();
        saveSentDeliveryIds_(config.properties, sentDeliveryIds);
        results.push({ delivery_id: deliveryId, status: 'sent' });
      } catch (error) {
        results.push({
          delivery_id: deliveryId,
          status: 'failed',
          error: String(error && error.message ? error.message : 'Gmail delivery failed').slice(0, 500),
        });
      }
    }

    if (results.length) {
      callNotificationFunction_(config, { action: 'complete', results });
    }
  } finally {
    lock.releaseLock();
  }
}

function installNotificationTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'runNotificationWorker')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('runNotificationWorker').timeBased().everyMinutes(1).create();
}

function removeNotificationTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'runNotificationWorker')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}
