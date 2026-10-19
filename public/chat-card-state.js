/** Decoration follows execution state only; business review conclusions never turn a normal reply red. */
export function setChatCardState(card, state) {
  card.classList.toggle('is-error-card', state === 'error' || state === 'failed');
  card.classList.toggle('is-waiting-card', ['queued','waiting','waiting_user'].includes(state));
  card.classList.remove('is-latest-card');
  return card;
}

/** Recompute within one visible conversation after rendering or paging; old history never keeps a stale latest marker. */
export function highlightLatestChatCard(root) {
  const cards = [...root.querySelectorAll('.chat-row > .chat-col > .chat-bubble')];
  for (const card of cards) card.classList.remove('is-latest-card');
  cards.filter(card => !card.classList.contains('is-error-card') && !card.classList.contains('is-waiting-card')).at(-1)?.classList.add('is-latest-card');
}
