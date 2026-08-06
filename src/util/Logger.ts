/* eslint-disable @typescript-eslint/no-explicit-any */

import { EOL } from 'os';
import util from 'util';
import cloneDeep from 'lodash/cloneDeep';

export default interface Logger {
  info(message?: any, ...args: any[]): void;
  warn(message?: any, ...args: any[]): void;
  debug(message?: any, ...args: any[]): void;
  error(message?: any, ...args: any[]): void;
}
export interface ExLogger extends Logger {
  success(message?: any, ...args: any[]): void;
}

function isExLogger(obj: any): obj is ExLogger {
  return typeof obj.success === 'function';
}

let _logger: Logger;
export const logger = () => _logger ?? console;
export const initLogger = (logger: Logger) => _logger = logger;

export class PrefixLogger implements ExLogger {
  constructor(
    public log: Logger,
    public prefix: string = '',
    public debugMode = false,
  ) {
    this.debugMode = this.debugMode || process.argv.includes('-D') || process.argv.includes('--debug');
  }

  debug(message?: any, ...args: any[]) {
    message = typeof message === 'string' ? this.masking(message) : this.maskingValue(message);
    args = args?.map(arg => typeof arg === 'string' ? this.masking(arg) : this.maskingValue(arg));
    if (this.debugMode) {
      this.log.info(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
    } else {
      this.log.debug(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
    }
  }

  info(message?: any, ...args: any[]) {
    message = typeof message === 'string' ? this.masking(message) : this.maskingValue(message);
    args = args?.map(arg => typeof arg === 'string' ? this.masking(arg) : this.maskingValue(arg));
    this.log.info(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
  }

  warn(message?: any, ...args: any[]) {
    message = typeof message === 'string' ? this.masking(message) : this.maskingValue(message);
    args = args?.map(arg => typeof arg === 'string' ? this.masking(arg) : this.maskingValue(arg));
    this.log.warn(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
  }

  error(message?: any, ...args: any[]) {
    message = typeof message === 'string' ? this.masking(message) : this.maskingValue(message);
    args = args?.map(arg => typeof arg === 'string' ? this.masking(arg) : this.maskingValue(arg));
    this.log.error(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
  }

  success(message?: any, ...args: any[]) {
    message = typeof message === 'string' ? this.masking(message) : this.maskingValue(message);
    args = args?.map(arg => typeof arg === 'string' ? this.masking(arg) : this.maskingValue(arg));
    if (isExLogger(this.log)) {
      this.log.success(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
    } else {
      this.log.info(util.format(`[%s] ${typeof message === 'string' ? '%s' : '%O'}`, this.prefix, message), ...args);
    }
  }

  private masking(str: string) : string {
    if (typeof str !== 'string') {
      return str;
    }
    const sensitiveKey = 'password|token|access_?token|refresh_?token|access_?key|access_?id|client_?id'
      + '|local_?key|tuya_?key|api_?key|secret|authorization|x-token|sign';
    const regex_single = new RegExp(`'(${sensitiveKey})'\\s*:\\s*'[^']*'`, 'gi');
    const regex_double = new RegExp(`"(${sensitiveKey})"\\s*:\\s*"[^"]*"`, 'gi');
    const spilts = str.split(/\r\n|\n|\r/);
    const results = spilts
      .map(a => a.replace(regex_single, '\'$1\': \'********\''))
      .map(a => a.replace(regex_double, '"$1": "********"'));
    return results.join(EOL);
  }

  private maskingValue(obj: any) {
    if (obj === null || obj === undefined) {
      return obj;
    }
    const cloneObj = cloneDeep(obj);
    const sensitiveKey = 'password|token|access_?token|refresh_?token|access_?key|access_?id|client_?id'
      + '|local_?key|tuya_?key|api_?key|secret|authorization|x-token|sign';
    const regex = new RegExp(`^(?:${sensitiveKey})$`, 'i');
    for (const key in cloneObj) {
      const value = cloneObj[key];
      if (typeof value === 'function') {
        continue;
      }
      if (typeof value === 'string') {
        if (!regex.test(key)) {
          continue;
        }
        cloneObj[key] = '*'.repeat(value.length);
      } else {
        cloneObj[key] = this.maskingValue(value);
      }
    }
    return cloneObj;
  }
}
