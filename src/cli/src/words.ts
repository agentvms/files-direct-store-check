/**
 * The fixed words the program uses for how a run ended, the exit status of each, and the sentence a person reads.
 * The words and the exit statuses are a contract: scripts and agents read them (cli/README.md lists them). Plain words, per docs/WORDING.md.
 */
export const REASONS = [
  'declined',
  'room_gone',
  'room_full',
  'wrong_code',
  'wrong_password',
  'password_needed',
  'rooms_paused',
  'network',
  'nobody_came',
  'timed_out',
  'too_many_rooms',
  'slow_down',
  'relay_limit',
  'month_stop',
  'out_of_date',
  'cancelled',
  'closed',
  'sender_left',
  'lost',
  'damaged',
  'unreadable',
  'no_room_left',
  'save_failed',
  'too_big',
  'too_many_files',
  'would_overwrite',
  'not_allowed',
  'nothing_to_send',
  'nothing_sent',
  'ask_link',
] as const;
export type Reason = (typeof REASONS)[number];
export type Outcome = 'finished' | Reason;

/** 0 finished. 3 the other side said no. 4 could not get in. 5 a limit (wait and try again). 6 out of date. 7 cancelled. 8 the transfer broke. 9 refused by a rule here. 2 is for how the command was typed, 1 for anything else. */
export const EXIT: Record<Outcome, number> = {
  finished: 0,
  declined: 3,
  room_gone: 4,
  room_full: 4,
  wrong_code: 4,
  wrong_password: 4,
  password_needed: 4,
  rooms_paused: 4,
  network: 4,
  nobody_came: 4,
  timed_out: 4,
  too_many_rooms: 5,
  slow_down: 5,
  relay_limit: 5,
  month_stop: 5,
  out_of_date: 6,
  cancelled: 7,
  closed: 7,
  sender_left: 8,
  lost: 8,
  damaged: 8,
  unreadable: 8,
  no_room_left: 8,
  save_failed: 8,
  too_big: 9,
  too_many_files: 9,
  would_overwrite: 9,
  not_allowed: 9,
  nothing_to_send: 9,
  nothing_sent: 3,
  ask_link: 9,
};

/** "30 seconds", "2 minutes", "1 hour". */
export function waitText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return s === 1 ? '1 second' : `${s} seconds`;
  if (s < 3600) {
    const m = Math.ceil(s / 60);
    return m === 1 ? '1 minute' : `${m} minutes`;
  }
  const h = Math.ceil(s / 3600);
  return h === 1 ? '1 hour' : `${h} hours`;
}

export function reasonText(reason: Outcome, ctx: { wait?: number; install?: string } = {}): string {
  const wait = ctx.wait === undefined ? ' in a little while' : ' in ' + waitText(ctx.wait);
  switch (reason) {
    case 'finished':
      return 'Done. Everything arrived and every file was checked.';
    case 'declined':
      return 'The other side did not accept. Nothing was sent.';
    case 'room_gone':
      return 'This link or code does not work any more. Ask the sender for a new one.';
    case 'room_full':
      return 'Another device is receiving from this room right now. Try again when it has everything.';
    case 'wrong_code':
      return 'No open room has that code. Check the digits, or ask the sender if it is still open.';
    case 'wrong_password':
      return 'That password is not right.';
    case 'password_needed':
      return 'This room has a password. Run the command again with --password.';
    case 'rooms_paused':
      return 'New rooms are paused for a short while. Try again later.';
    case 'network':
      return 'We could not reach the server. Check the connection and try again.';
    case 'nobody_came':
      return 'Nobody joined in time, so the room was closed.';
    case 'timed_out':
      return 'This took too long, so you were not let in. Ask the sender, then try again.';
    case 'too_many_rooms':
      return `Too many rooms were opened from this connection just now. Try again${wait}.`;
    case 'slow_down':
      return `Too many wrong codes or passwords from this connection. Try again${wait}.`;
    case 'relay_limit':
      return 'The free amount for sending through our servers is used up, so the transfer was paused. Connecting directly (the same network, or another connection) still works.';
    case 'month_stop':
      return 'Sending through our servers is switched off for the rest of this month. Connecting directly still works.';
    case 'out_of_date':
      return `The two sides do not speak the same version. Update this program with ${ctx.install ?? 'the install line on the Files Direct page for agents'}, and ask the other side to refresh if it is a page.`;
    case 'cancelled':
      return 'The transfer was cancelled. Files that had already arrived whole and passed their checks were kept; nothing else was saved.';
    case 'closed':
      return 'The room was closed.';
    case 'sender_left':
      return 'The sender closed the room before the files arrived.';
    case 'lost':
      return 'The connection was lost. Open the link again, or ask the sender for a new one.';
    case 'damaged':
      return 'A file could not be made right after several tries. Ask for it to be sent again.';
    case 'unreadable':
      return 'Something unexpected arrived, so the transfer stopped. Ask the sender to send it again.';
    case 'no_room_left':
      return 'There is no room left on the disk, so the transfer stopped. Free up some space and try again.';
    case 'save_failed':
      return 'A file arrived and was checked, but it could not be saved where it belongs.';
    case 'too_big':
      return 'What was offered is bigger than the limit you set (--max-size). Nothing was received.';
    case 'too_many_files':
      return 'What was offered has more files than the limit you set (--max-files). Nothing was received.';
    case 'would_overwrite':
      return 'A file with the same name is already in the folder. Nothing was replaced. Use --overwrite to replace it, or save into another folder.';
    case 'not_allowed':
      return 'This path is not one the program may use.';
    case 'nothing_to_send':
      return 'There is nothing to send: no files were found in what was named.';
    case 'nothing_sent':
      return 'Someone opened the request, but no files came in time, so the room was closed.';
    case 'ask_link':
      return 'This link asks for files. It does not offer any. Open it in a browser to choose files, or send your own with files-direct send.';
  }
}
