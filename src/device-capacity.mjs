import {tr} from './i18n.mjs';
/** All managed runtimes share one device limit; invalid values never mean unlimited. */
export function validateCliCapacity(value) {
  if(!Number.isInteger(value)||value<1||value>64)throw new Error(tr('capacity.invalid'));
  return value;
}

/** Prepared terminal takeovers reserve a slot before the user starts the CLI. */
export function reservedTerminalSlots(db,nodeId) {
  return db.list('terminalSessions').filter(s=>s.nodeId===nodeId&&['preparing','prepared','active'].includes(s.status)).length;
}

/** Older Workers cannot be overallocated; new Workers apply saved limits before ready. */
export function registrationCapacity(node,config) {
  const appliedCapacity=validateCliCapacity(Number(node.capacity||1));
  const desiredCapacity=validateCliCapacity(config?.capacity??appliedCapacity);
  return {capacity:node.capabilities?.cliCapacity===1?desiredCapacity:Math.min(desiredCapacity,appliedCapacity),desiredCapacity,appliedCapacity};
}
