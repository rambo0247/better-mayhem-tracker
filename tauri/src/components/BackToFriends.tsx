import { useNavigate } from "@solidjs/router";
import type { FriendsLink } from "../lib/types";
import { ChevronRightIcon } from "./icons";

// Sits in a detail page's kicker, so it takes the kicker's type and only adds
// the arrow and a hover. `link` is the view to land on, for a page that opened
// from one other than the list's default. The router claims no plain anchor
// (explicitLinks), so the state goes through navigate; a modified click is
// left to the webview, as React Router's Link leaves it.
export default function BackToFriends(props: { link?: FriendsLink }) {
  const navigate = useNavigate();
  return (
    <a
      href="#/friends"
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey
        ) {
          return;
        }
        event.preventDefault();
        navigate("/friends", { state: props.link });
      }}
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
