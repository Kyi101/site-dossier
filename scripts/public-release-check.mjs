#!/usr/bin/env node
// Audit the index and every local Git ref before making a repository public.
// Ignoring or untracking files does not erase them from existing history.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public authors accepted only for the exact, already-reviewed GitHub squash
// commits. A commit hash binds its author metadata, tree, and parents; this does
// not allow that address on any future commit or exempt any file content.
const reviewedPublicAuthorCommits = new Set([
  '807f7b1ded2a8b6b0e83994965c6e1485e94cd67', // Kyi101/site-dossier PR #3
  'b5ee10c1be2b9548b80fbbe36aa63cd2c2d8a734', // Kyi101/site-dossier PR #2
]);
const isUserNoreply = email => /^(?:\d+\+)?[a-z\d][a-z\d-]*(?:\[bot\])?@users\.noreply\.github\.com$/i.test(email);

export function isAllowedHistoryIdentity(revision, authorEmail, committerEmail) {
  return (isUserNoreply(authorEmail) || reviewedPublicAuthorCommits.has(revision)) &&
    (isUserNoreply(committerEmail) || committerEmail === 'noreply@github.com');
}

export function auditPublicRelease(root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const lines = value => value.split(/\r?\n/).filter(Boolean);
  const privatePath = path =>
    /^(?:CLAUDE\.md|AGENTS\.md|AUTONOMY\.md|STATUS\.md|DECISIONS\.md|NOTES\.md|docs\/(?:chrome-web-store\.md|superpowers\/|ui\/|design\/)|prompts\/|prototypes\/|\.superpowers\/|\.claude\/|\.codex\/|\.agents\/|data\/|runs\/|captures\/|screenshots\/|dist\/|offscreen\/ffmpeg\/)/.test(path);
  const errors = [];
  const indexPaths = git('ls-files', '-z').split('\0').filter(Boolean);
  const indexedPrivate = indexPaths.filter(privatePath);
  if (indexedPrivate.length) errors.push(`Release-excluded paths still tracked: ${indexedPrivate.join(', ')}`);

  const historicalPaths = new Set(lines(git('log', '--all', '--format=', '--name-only')));
  const historicalPrivate = [...historicalPaths].filter(privatePath).sort();
  if (historicalPrivate.length) {
    errors.push(`Release-excluded paths in Git history: ${historicalPrivate.join(', ')}`);
  }

  const identities = lines(git('log', '--all', '--format=%H%x09%ae%x09%ce'));
  const unreviewed = identities.filter(line => !isAllowedHistoryIdentity(...line.split('\t')));
  if (unreviewed.length) {
    errors.push(`Git history contains unreviewed author or committer addresses in commits: ${unreviewed.map(line => line.split('\t')[0]).join(', ')}`);
  }
  const configuredEmail = git('config', 'user.email').trim();
  if (!isUserNoreply(configuredEmail)) {
    errors.push('Future commits are not configured to use a GitHub noreply address.');
  }

  const textExtensions = /(?:\.(?:js|mjs|json|md|html|css|py|txt)|^\.gitignore)$/;
  const personalMarkers = /\/home\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\|[\w.+-]+@gmail\.com/i;
  const markedPaths = indexPaths.filter(path => {
    if (privatePath(path) || !textExtensions.test(path)) return false;
    const absolute = resolve(root, path);
    return existsSync(absolute) && personalMarkers.test(readFileSync(absolute, 'utf8'));
  });
  if (markedPaths.length) {
    errors.push(`Publishable files contain personal path or email markers: ${markedPaths.join(', ')}`);
  }

  // Check historical public file contents too. Cache blobs so unchanged files
  // are inspected once even when several commits contain them.
  const markedBlobs = new Map();
  const historicalMarkedPaths = new Set();
  for (const revision of lines(git('rev-list', '--all'))) {
    const entries = git('ls-tree', '-rz', revision).split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match) continue;
      const [, objectId, path] = match;
      if (privatePath(path) || !textExtensions.test(path)) continue;
      if (!markedBlobs.has(objectId)) {
        markedBlobs.set(objectId, personalMarkers.test(git('cat-file', 'blob', objectId)));
      }
      if (markedBlobs.get(objectId)) historicalMarkedPaths.add(path);
    }
  }
  if (historicalMarkedPaths.size) {
    errors.push(`Publishable files contain personal markers in Git history: ${[...historicalMarkedPaths].sort().join(', ')}`);
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = auditPublicRelease();
  if (errors.length) {
    console.error('Public release check failed:');
    for (const error of errors) console.error(`- ${error}`);
    console.error('Do not publish this source until the reported paths and identities are reviewed.');
    process.exitCode = 1;
  } else {
    console.log('Public release check passed: index, all Git refs, reviewed commit identities, and historical personal markers.');
  }
}
