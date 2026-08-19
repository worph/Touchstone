/**
 * `GET /alerts` — open environment conditions, and the resolved ones behind them.
 *
 * Open alerts are what the Activity page leads with and what the nav badge counts. The
 * resolved list is served alongside because "the bench recovered at 11:02" is the answer
 * to the question the open list stops answering the moment it empties.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { AlertsResponse } from '../../shared/activity.js';
import type { AlertStore } from '../services/alerts.js';

export interface AlertsRoutesOptions {
  alerts?: AlertStore;
}

const routes: FastifyPluginAsync<AlertsRoutesOptions> = async (app, options) => {
  app.get('/alerts', async (): Promise<AlertsResponse> => {
    const store = options.alerts;
    if (!store) return { open: [], resolved: [] };
    return {
      open: store.openAlerts(),
      resolved: store.all().filter((a) => a.state === 'resolved'),
    };
  });
};

export default routes;
