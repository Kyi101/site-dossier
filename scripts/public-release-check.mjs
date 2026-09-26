#!/usr/bin/env node
// Audit the index and every local Git ref before making a repository public.
// Ignoring or untracking files does not erase them from existing history.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
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

const emails = new Set(lines(git('log', '--all', '--format=%ae%n%ce')));
if ([...emails].some(email => !/^\d+\+[^@]+@users\.noreply\.github\.com$/.test(email))) {
  errors.push('Git history contains author or committer addresses other than GitHub noreply.');
}
const configuredEmail = git('config', 'user.email').trim();
if (!/^\d+\+[^@]+@users\.noreply\.github\.com$/.test(configuredEmail)) {
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

if (errors.length) {
  console.error('Public release check failed:');
  for (const error of errors) console.error(`- ${error}`);
  console.error('Keep the existing remote private. Clean every public branch and tag before changing visibility.');
  process.exitCode = 1;
} else {
  console.log('Public release check passed: index, all Git refs, commit addresses, and historical personal markers.');
}
