import { describe, expect, test } from "bun:test";
import { invokeError } from "./api";

describe("invokeError", () => {
  test("a command's rejection reads as Electron's, with its code", () => {
    const error = invokeError("app:version", {
      name: "Error",
      message: "not ported",
      code: "NOT_PORTED",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Error invoking remote method 'app:version': Error: not ported");
    expect(error.code).toBe("NOT_PORTED");
  });

  test("an unknown command reads as Electron's unregistered channel", () => {
    // The text Tauri rejected with in the live probe, and Electron's from the T05 golden
    const error = invokeError(
      "bmt:unregistered-channel",
      "Command bmt:unregistered-channel not found",
    );
    expect(error.message).toBe(
      "Error invoking remote method 'bmt:unregistered-channel': Error: No handler registered for 'bmt:unregistered-channel'",
    );
    expect(error.code).toBeUndefined();
  });

  test("Tauri's own argument errors keep their text", () => {
    const error = invokeError("db:match-detail", "invalid args `gameId` for command");
    expect(error.message).toBe(
      "Error invoking remote method 'db:match-detail': Error: invalid args `gameId` for command",
    );
  });
});
