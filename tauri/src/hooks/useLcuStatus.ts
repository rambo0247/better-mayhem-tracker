import { createSignal, onSettled } from "solid-js";
import { api } from "../lib/api-shim";
import type { LcuStatus } from "../lib/types";

export function useLcuStatus() {
  const [status, setStatus] = createSignal<LcuStatus>("disconnected");

  onSettled(() => {
    void api.getLcuStatus().then(setStatus);
    return api.onStatusChanged((s) => setStatus(s));
  });

  return status;
}
