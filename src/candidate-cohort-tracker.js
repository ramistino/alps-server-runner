'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { asObject, finite, iso, text, timestamp } = require('./utils');

function stableId(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

class CandidateCohortTracker {
  constructor({ config, log = console.log }) {
    this.config = config;
    this.log = log;
    const dataDir = process.env.ALPS_DATA_DIR || path.join(config.rootDir, 'data');
    this.stateFile = path.join(dataDir, 'v102-candidate-cohort-authority.json');
    this.state = {
      schema:'alps.v10200.candidateCohortAuthority.v1',
      cohortId:null,
      authorityEpoch:null,
      firstSeenAt:null,
      lastSeenAt:null,
      observationCount:0,
      stableObservationCount:0,
      candidates:0,
      nativePool:0,
      forwardLatch:0,
      discoveryToNativeGap:0,
      nativeToLatchGap:0,
      discoveryToLatchGap:0,
      nativeOverflow:0,
      latchOverflow:0,
      persistentGapConfirmed:false,
      status:'WAITING_FOR_COHORT',
      persistedAt:null,
    };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') this.state = {...this.state, ...parsed};
    } catch (error) {
      this.log('[candidate-cohort] load failed', error && error.message || error);
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive:true });
      const temp = `${this.stateFile}.tmp`;
      const payload = {...this.state, persistedAt:iso()};
      fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
      fs.renameSync(temp, this.stateFile);
      this.state.persistedAt = payload.persistedAt;
    } catch (error) {
      this.log('[candidate-cohort] persist failed', error && error.message || error);
    }
  }

  observe({ live, candidateAuthority, now = Date.now() }) {
    const root = asObject(live);
    const current = asObject(root.currentHealth);
    const authority = asObject(candidateAuthority);
    const candidates = Math.max(0, finite(root.candidates, current.candidates || 0));
    const nativePool = Math.max(0, finite(root.nativePoolCandidates, current.nativePoolCandidates || 0));
    const forwardLatch = Math.max(0, finite(root.forwardLatchSize, current.forwardLatchSize || 0));
    const authorityEpoch = text(
      authority.candidateEpochId ||
      authority.epochId ||
      authority.generatedAt ||
      current.candidateEpochId ||
      current.candidateAuthorityGeneratedAt ||
      'NO_EXPLICIT_EPOCH'
    );
    const tuple = { authorityEpoch, candidates, nativePool, forwardLatch };
    const cohortId = stableId(tuple);
    const same = cohortId === this.state.cohortId;

    if (!same) {
      this.state = {
        ...this.state,
        cohortId,
        authorityEpoch,
        firstSeenAt:iso(now),
        lastSeenAt:iso(now),
        observationCount:this.state.observationCount + 1,
        stableObservationCount:1,
        candidates,
        nativePool,
        forwardLatch,
      };
    } else {
      this.state.lastSeenAt = iso(now);
      this.state.observationCount += 1;
      this.state.stableObservationCount += 1;
      this.state.candidates = candidates;
      this.state.nativePool = nativePool;
      this.state.forwardLatch = forwardLatch;
    }

    const discoveryToNativeGap = Math.max(0, candidates - nativePool);
    const nativeToLatchGap = Math.max(0, nativePool - forwardLatch);
    const discoveryToLatchGap = Math.max(0, candidates - forwardLatch);
    const nativeOverflow = Math.max(0, nativePool - candidates);
    const latchOverflow = Math.max(0, forwardLatch - nativePool);
    const age = this.state.firstSeenAt ? Math.max(0, (now - timestamp(this.state.firstSeenAt))/1000) : 0;
    const aligned = discoveryToLatchGap === 0 && discoveryToNativeGap === 0 && nativeToLatchGap === 0 && nativeOverflow === 0 && latchOverflow === 0;
    const confirmByCount = this.state.stableObservationCount >= this.config.candidateGapConfirmObservations;
    const confirmByAge = age >= this.config.candidateGapConfirmSec;
    const persistentGapConfirmed = !aligned && confirmByCount && confirmByAge;

    this.state.discoveryToNativeGap = discoveryToNativeGap;
    this.state.nativeToLatchGap = nativeToLatchGap;
    this.state.discoveryToLatchGap = discoveryToLatchGap;
    this.state.nativeOverflow = nativeOverflow;
    this.state.latchOverflow = latchOverflow;
    this.state.persistentGapConfirmed = persistentGapConfirmed;
    this.state.status = aligned
      ? 'COHORT_ALIGNED'
      : persistentGapConfirmed
        ? 'PERSISTENT_COHORT_GAP_CONFIRMED'
        : 'TRANSITION_IN_FLIGHT_UNCONFIRMED';
    this.state.sameCohortAgeSec = Math.round(age * 1000) / 1000;
    this.state.requiredConfirmations = this.config.candidateGapConfirmObservations;
    this.state.requiredAgeSec = this.config.candidateGapConfirmSec;
    this.state.pass = aligned || !persistentGapConfirmed;
    this.state.rule = 'A discovery/native/latch difference fails only after the exact same observed cohort tuple persists for the configured observation count and time. Single asynchronous snapshots never prove candidate loss.';
    this.persist();
    return this.view();
  }

  view() {
    return {...this.state, persistence:'PERSISTENT_DISK_ENABLED'};
  }
}

module.exports = { CandidateCohortTracker };
