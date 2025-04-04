import { handler } from '../../../src/functions/findAvailableSlotsHandler.js';
import { describe, test, expect } from '@jest/globals'

describe('testing handler setup correctly', () => {
  test('handler should return appropriate response', () => {
    expect(handler()).toBe("Reached lambda function");
  });
});
