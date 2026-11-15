/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChromeModernWebGuidance } from '../types.ts';

export interface ClearcutSenderConfig {
  clearcutEndpoint?: string;
  includePidHeader?: boolean;
}

const MAX_BUFFER_SIZE = 1000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface BufferedEvent {
  event: ChromeModernWebGuidance;
  timestamp: number;
}

function logger(...args: any[]) {
  if (process.env.DEBUG_MWG_TELEMETRY === '1') {
    console.error('[ClearcutSender]', ...args);
  }
}

export class ClearcutSender {
  #buffer: BufferedEvent[] = [];

  constructor(_config: ClearcutSenderConfig = {}) {
    // Configuration is ignored. This fork never contacts a telemetry endpoint.
  }

  enqueueEvent(event: ChromeModernWebGuidance): void {
    logger('Enqueuing telemetry event', JSON.stringify(event, null, 2));
    if (this.#buffer.length >= MAX_BUFFER_SIZE) {
      this.#buffer.shift();
      logger('Telemetry buffer overflow: dropped oldest event');
    }
    this.#buffer.push({
      event,
      timestamp: Date.now(),
    });
  }

  async sendShutdownEvent(): Promise<void> {
    if (this.#buffer.length === 0) {
      return;
    }
    const eventsToSend = [...this.#buffer];
    this.#buffer = [];

    try {
      await Promise.race([
        this.#sendBatch(eventsToSend),
        new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
      logger('Final flush completed');
    } catch (error) {
      logger('Final flush failed:', error);
    }
  }

  async #sendBatch(events: BufferedEvent[]): Promise<void> {
    logger(`Dropped ${events.length} telemetry events. This fork does not upload usage data.`);
  }
}
