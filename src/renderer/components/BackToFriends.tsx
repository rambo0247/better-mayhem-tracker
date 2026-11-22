import { Link } from "react-router-dom";
import type { FriendsLink } from "../lib/types";
import { ChevronRightIcon } from "./icons";

// Sits in a detail page's kicker, so it takes the kicker's type and only adds
// the arrow and a hover. `link` is the view to land on, for a page that opened
// from one other than the list's default.
export default function BackToFriends({ link }: { link?: FriendsLink }) {
  return (
    <Link
      to="/friends"
      state={link}
      className="group inline-flex items-center gap-1 text-lol-gold transition-colors hover:text-lol-gold-light"
    >
      <ChevronRightIcon
        aria-hidden
        strokeWidth={3}
        className="h-3 w-3 rotate-180 transition-transform group-hover:-translate-x-0.5"
      />
      Friends
    </Link>
  );
}
