import { createEffect, For, Show } from "solid-js";
import { useFilterOptions } from "../hooks/useFilterOptions";

export default function AccountSelect(props: {
  value: string | undefined;
  onChange: (account: string | undefined) => void;
}) {
  const options = useFilterOptions();
  const accounts = () => options().accounts;

  // Clear the selection if new data leaves it without any matching games
  createEffect(
    () => ({ accounts: accounts(), value: props.value }),
    ({ accounts, value }) => {
      if (value !== undefined && accounts.length > 0 && !accounts.some((a) => a.puuid === value)) {
        props.onChange(undefined);
      }
    },
  );

  // A single-account database doesn't need an account dropdown
  return (
    <Show when={accounts().length >= 2}>
      <select
        value={props.value ?? ""}
        onChange={(e) =>
          props.onChange(e.currentTarget.value === "" ? undefined : e.currentTarget.value)
        }
        class="select"
      >
        <option value="">All Accounts</option>
        <For each={accounts()}>
          {(a) => <option value={a.puuid}>{a.name ?? "Unknown account"}</option>}
        </For>
      </select>
    </Show>
  );
}
