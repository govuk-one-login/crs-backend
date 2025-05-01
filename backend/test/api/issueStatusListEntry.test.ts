import { randomUUID } from "crypto";
import { SESSIONS_API_INSTANCE } from "../utils/apiInstance";
import { createSessionForSub, getAccessToken } from "../utils/apiTestHelpers";

jest.setTimeout(4 * 5000);

  describe("Given the request is valid and a session is found", () => {
    it("Returns 200 status code, sessionId, redirectUri and state", async () => {
      const sub = randomUUID();
      await createSessionForSub(sub);
      const accessToken = await getAccessToken(sub);

      const response = await SESSIONS_API_INSTANCE.get("/crs/issueStatusListEntry", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      expect(response.status).toBe(200);
      expect(response.data["sessionId"]).toBeDefined();
      expect(response.data["redirectUri"]).toBeDefined();
      expect(response.data["state"]).toBeDefined();
    });
});

