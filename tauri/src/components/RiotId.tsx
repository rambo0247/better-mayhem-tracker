import { Show } from "solid-js";

// A player's Riot ID with its name and tag each isolated from the text around
// them. A name in a right-to-left script (Arabic, on the Middle East server)
// would otherwise pull a numeric tag, or a count beside it, over to its own
// side. An ID without a tag is shown as it is.
export default function RiotId(props: { id: string }) {
  const hash = () => props.id.lastIndexOf("#");
  return (
    <Show when={hash() > 0} fallback={<bdi>{props.id}</bdi>}>
      <bdi>{props.id.slice(0, hash())}</bdi>#<bdi>{props.id.slice(hash() + 1)}</bdi>
    </Show>
  );
}
