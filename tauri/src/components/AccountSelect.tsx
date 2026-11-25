import { createEffect, Show } from "solid-js";
import { useFilterOptions } from "../hooks/useFilterOptions";
import Select from "./Select";

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
      <Select
        value={props.value}
        options={[
          { value: undefined, label: "All Accounts" },
          ...accounts().map((a) => ({ value: a.puuid, label: a.name ?? "Unknown account" })),
        ]}
        onChange={props.onChange}
      />
    </Show>
  );
}
