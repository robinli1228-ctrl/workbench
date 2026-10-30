import {setTimeout as sleep} from 'node:timers/promises';

/**
 * Media bytes leave a device no faster than its link to Home carries them. A link slower than the bytes offered queues them
 * (in the kernel and in the SSH tunnel), and the Worker's run events and query replies wait behind that queue: one video on a
 * 25 KB/s link held up every task for minutes. While uploads run, Home times a tiny control round trip each second and sets
 * the rate (MediaRate) so that round trip stays short; the Worker spaces its uploads to it (MediaPace). Files may be slow,
 * nothing else waits for them.
 */
export const MEDIA_RATE=Object.freeze({start:32*1024,min:4*1024,max:1024**3,windowMs:1000,fastTripMs:100});

/** One budget shared by every upload of this Worker: each chunk reserves its time slot, first come first served. */
export class MediaPace {
  constructor({rate=MEDIA_RATE.start,clock=()=>Date.now()}={}) {this.clock=clock;this.next=0;this.set(rate);}
  set(rate) {if(Number.isFinite(rate)&&rate>0)this.rate=Math.min(MEDIA_RATE.max,Math.max(MEDIA_RATE.min,rate));}
  /** Waits until `bytes` may be sent. An idle link earns no burst; waits under 5 ms are folded into later ones. */
  async take(bytes,signal) {
    const now=this.clock(),start=Math.max(now,this.next);
    this.next=start+bytes/this.rate*1000;
    if(start-now>=5)await sleep(start-now,undefined,{signal});
  }
}

/**
 * Home's view of one device's link, from what matters: how long a small control message takes to come back. Its round trip
 * above the link's own (the least seen lately) is time spent queued behind media. Over a second queued: halve (below what
 * arrives) and hold until the queue is gone (halving again only if it keeps growing), then resume just under what arrived.
 * Short and arrivals keeping up with the rate: grow, doubling (eightfold on a sub-100 ms link) until the first queue and by a
 * tenth after it. Growth needs a window in which no upload began or ended and no viewer stopped reading; a queue is acted
 * on in any window.
 */
export class MediaRate {
  constructor({rate=MEDIA_RATE.start}={}) {Object.assign(this,{rate,growing:true,draining:false,bytes:0,clean:true,trips:[],queued:0});}
  /** Bytes that arrived since the last sample. */
  add(bytes) {this.bytes+=bytes;}
  /** Something made this window unrepresentative (an upload started or ended, a viewer paused). */
  disturb() {this.clean=false;}
  /** No uploads: whatever was queued drains on its own. */
  idle() {this.draining=false;this.bytes=0;this.clean=true;}
  /** One control round trip of `trip` ms, `ms` after the previous sample; returns the new rate when it changed, else null. */
  sample(trip,ms) {
    const arrived=ms>0?this.bytes/ms*1000:0,clean=this.clean,before=this.rate;this.bytes=0;this.clean=true;
    this.trips.push(trip);if(this.trips.length>60)this.trips.shift();
    const queued=trip-Math.min(...this.trips),fast=this.growing&&Math.min(...this.trips)<MEDIA_RATE.fastTripMs;
    // Once cut, the queue needs a few seconds to drain at the lower rate: cut again only if it still grows. A trip already
    // cut for while it was out (late) is not cut for again.
    const worse=!this.draining||queued>this.queued+250;this.queued=queued;
    if(queued>1000){if(worse&&!this.lateCut)this.cut(arrived);}
    else if(this.draining){if(queued<300){this.draining=false;this.rate=Math.max(this.rate,arrived*0.9);}}
    // A link with a round trip under 100 ms (the same machine, a LAN) gets to full speed in a few seconds, not ten.
    // Short quarter-second windows on a fast link catch only a few paced pieces, so their arrivals read low: ramp on 60%.
    else if(clean&&queued<300&&arrived>=this.rate*(fast?0.6:0.85))this.rate=Math.min(MEDIA_RATE.max,this.rate*(!this.growing?1.1:fast?8:2));
    return this.rate===before?null:this.rate;
  }
  /** A round trip still out after `ms`: the queue is already long; cut once for it. Returns the new rate or null. */
  late(ms) {
    if(ms<=1500||this.lateCut)return null;
    const arrived=ms>0?this.bytes/ms*1000:0,before=this.rate;this.lateCut=true;this.cut(arrived);
    return this.rate===before?null:this.rate;
  }
  cut(arrived) {this.growing=false;this.draining=true;this.rate=Math.max(MEDIA_RATE.min,Math.min(this.rate,arrived||this.rate)/2);}
}
