import type { FriendsLink } from "../lib/types";
import { ChevronRightIcon } from "./icons";

// Sits in a detail page's kicker, so it takes the kicker's type and only adds
// the arrow and a hover. `link` is the view to land on, for a page that opened
// from one other than the list's default. The router reads a link's `state`
// attribute as JSON and hands it to the page as its location state.
export default function BackToFriends(props: { link?: FriendsLink }) {
  return (
    <a
      href="#/friends"
      state={props.link ? JSON.stringify(props.link) : undefined}
      class="group inline-flex items-center gap-1 text-lol-gold transition-colors hover:text-lol-gold-light"
    >
      <ChevronRightIcon
        aria-hidden="true"
        stroke-width={3}
        class="h-3 w-3 rotate-180 transition-transform group-hover:-translate-x-0.5"
      />
      Friends
    </a>
  );
}
