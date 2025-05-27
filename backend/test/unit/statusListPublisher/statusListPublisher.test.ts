import { handler } from "../../../src/functions/statusListPublisherHandler";
import { describe, test, expect } from "@jest/globals";

describe("testing handler setup correctly", () => {
  test("handler should return appropriate response", () => {
    expect(handler()).toBeInstanceOf(Response);
    expect(handler().status).toBe(501);
    expect(handler().statusText).toBe("Not Implemented");
  });
});
