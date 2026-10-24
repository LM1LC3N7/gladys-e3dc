// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the E3dcApp (src/app.js). Read-only: no command handler,
// the system is never commanded (no charge, discharge, wallbox or setting).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { E3dcApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new E3dcApp({ gladys });

// --- Discovery: the device of the system read, never a request by itself -----------
gladys.onScanRequest(() => app.scan());
// The device just created: the values of the last read now (no new request).
gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));

// --- Configuration screen buttons -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());
// The only way to take an index held back, in two clicks (a save of the form never does).
gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldIndex());

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated: restarting');
  return app.start(config, { fresh: true });
});

// --- Connection lifecycle ------------------------------------------------------
// Every connection (the first one and each reconnection) publishes the device
// and the status again, and every value at the next read.
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error(`Start failed (${err?.name ?? 'Error'})`);
  }
});
gladys.on('disconnected', () => {
  app.stop().catch((err) => logger.error(`Stop failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the E3/DC integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
