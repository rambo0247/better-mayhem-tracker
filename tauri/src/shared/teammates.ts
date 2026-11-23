// Someone we queued with once is a stranger, not a friend: the Friends list
// opens on players we've shared at least this many games with, and only they
// get a link from the live game.
export const MIN_SHARED_GAMES = 2;

// Match data doesn't say who queued together, so a group is read off the team:
// the players on it we've shared at least this many games with, across every
// game we have. Being matched with a stranger twice is common enough over a long
// history that a lower minimum lists strangers as groups.
export const MIN_GROUP_MEMBER_GAMES = 3;
