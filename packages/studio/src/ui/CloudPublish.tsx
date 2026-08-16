// Publishing, once there is a service to publish to.
//
// The offline panel hands the merchant two files and wishes them luck. This
// one gives them a URL and a snippet — and the snippet is the LIVE URL, so
// publishing a second time does not mean pasting a second time. The version
// list underneath is the safety net: every publish is kept, and any of them
// can be made live again without rebuilding anything.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { validateManifest } from '../../../embed/src/manifest/validate.ts';
import { frameCamera, withProductName, withCurrency } from '../lib/manifest-edit.ts';
import { writeGlb } from '../lib/write-glb.ts';
import { compressGlb } from '../lib/compress-glb.ts';
import { api, ApiError, embedSnippet, type PublicationSummary } from '../lib/api.ts';
import { relativeTime } from '../lib/format.ts';
import type { Project } from '../App.tsx';
import type { Manifest } from '../../../embed/src/manifest/types.ts';

const kb = (n: number) => `${(n / 1024).toFixed(0)} kB`;

function Copyable(props: { value: string; label: string; testId: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      {props.multiline
        ? <pre className="snippet" data-testid={props.testId}>{props.value}</pre>
        : <code className="copy-value" data-testid={props.testId}>{props.value}</code>}
      <button
        className="ghost" data-testid={`${props.testId}-copy`}
        onClick={async () => {
          try { await navigator.clipboard.writeText(props.value); } catch { /* no clipboard: the text is on screen */ }
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >{copied ? 'Copied' : `Copy ${props.label}`}</button>
    </div>
  );
}

export function CloudPublish(props: {
  project: Project;
  projectId: string;
  /** Written before publishing, so the service freezes what is on screen. */
  flush: () => Promise<void>;
  onChange: (m: Manifest) => void;
  embedBase: string;
  onPublished?: () => void;
}) {
  const { project, projectId, flush, onChange, embedBase } = props;
  const { manifest, model } = project;
  const report = useMemo(() => validateManifest(manifest), [manifest]);

  const [publications, setPublications] = useState<PublicationSummary[] | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [liveUrl, setLiveUrl] = useState('');
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [originDraft, setOriginDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const out = await api.listPublications(projectId);
      setPublications(out.publications);
      setLive(out.live);
      setLiveUrl(out.liveManifestUrl);
      const list = await api.listOrigins(projectId);
      setOrigins(list);
      setOriginDraft(list.join('\n'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not load this product’s versions');
    }
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);

  const publish = async () => {
    setBusy('publish');
    setError(null);
    setNote(null);
    try {
      // A saved view is kept verbatim; otherwise the camera is refit to the
      // model as finally laid out, since the init camera was framed before
      // any resizing or anchoring happened.
      const framed = manifest.camera?.userSet ? manifest : frameCamera(manifest, project.raw);
      if (framed !== manifest) onChange(framed);
      await flush();

      const used = new Set(framed.parts.map((p) => p.mesh.split('#')[1]));
      const raw = writeGlb(model.parts.filter((p) => used.has(p.name)));
      const packed = await compressGlb(raw);
      const out = await api.publish(projectId, packed);
      props.onPublished?.();
      setNote(`Version ${out.publication.version} is live. Model: ${kb(packed.length)} compressed, from ${kb(raw.length)} raw.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `publish failed: ${err}`);
    } finally {
      setBusy(null);
    }
  };

  const saveOrigins = async () => {
    setBusy('origins');
    setError(null);
    try {
      const wanted = originDraft.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      setOrigins(await api.setOrigins(projectId, wanted));
      setNote('Saved where this configurator may be embedded.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not save those addresses');
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();

  return (
    <div className="panel-body">
      <label className="field wide">
        <span className="field-label">Product name</span>
        <input
          defaultValue={manifest.name} data-testid="publish-name"
          onBlur={(e) => { try { onChange(withProductName(manifest, e.target.value)); setError(null); } catch (err) { setError(String(err)); } }}
        />
      </label>
      <label className="field wide">
        <span className="field-label">Currency</span>
        <input
          defaultValue={manifest.pricing.currency} maxLength={3} data-testid="publish-currency"
          onBlur={(e) => { try { onChange(withCurrency(manifest, e.target.value.toUpperCase())); setError(null); } catch (err) { setError(String(err)); } }}
        />
      </label>

      <div className={`report ${report.ok ? 'ok' : 'bad'}`} data-testid="validation-report">
        {report.ok
          ? `Valid — ${manifest.parts.length} parts, ${manifest.options.length} options.`
          : `${report.errors.length} error(s): ${report.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`}
        {report.warnings.length > 0 && (
          <ul>{report.warnings.map((w, i) => <li key={i}>{w.path}: {w.message}</li>)}</ul>
        )}
      </div>

      <div className="publish-actions">
        <button className="cta" data-testid="publish-now" disabled={!report.ok || !!busy} onClick={publish}>
          {busy === 'publish' ? 'Publishing…' : publications?.length ? 'Publish an update' : 'Publish'}
        </button>
      </div>
      {note && <p className="hint" role="status" data-testid="publish-note">{note}</p>}
      {error && <p className="error" role="alert" data-testid="publish-error">{error}</p>}

      {!!publications?.length && (
        <>
          <h4>Put it on your store</h4>
          <p className="hint">
            This address always serves whichever version is live, so publishing an update
            never means editing your store again.
          </p>
          <Copyable value={liveUrl} label="address" testId="live-url" />
          <Copyable value={embedSnippet(liveUrl, embedBase)} label="snippet" testId="snippet" multiline />

          <h4>Where it may be used</h4>
          <p className="hint">
            One address per line. Leave it empty and the configurator works on any site —
            fine to start with, worth locking down once you are live.
          </p>
          <textarea
            className="origins" rows={3} data-testid="origins-input"
            placeholder="https://yourshop.com"
            value={originDraft} onChange={(e) => setOriginDraft(e.target.value)}
          />
          <div className="publish-actions">
            <button className="cta" data-testid="origins-save" disabled={busy === 'origins'} onClick={saveOrigins}>
              {busy === 'origins' ? 'Saving…' : 'Save addresses'}
            </button>
            <span className="hint">
              {origins?.length ? `${origins.length} allowed` : 'Any site'}
            </span>
          </div>

          <h4>Versions</h4>
          <p className="hint">
            Every publish is kept. Orders record the version they were placed against, so
            an old order keeps rendering the product it was.
          </p>
          <ul className="version-list" data-testid="version-list">
            {publications.map((p) => (
              <li key={p.id} className={p.id === live ? 'is-live' : ''}>
                <span className="version-n">v{p.version}</span>
                <span className="version-when">{relativeTime(p.publishedAt, now)}</span>
                {p.id === live
                  ? <span className="dash-pill is-live">Live</span>
                  : (
                    <button
                      className="ghost" data-testid={`make-live-${p.version}`}
                      onClick={async () => {
                        try { await api.setLive(projectId, p.id); await reload(); } catch (err) {
                          setError(err instanceof ApiError ? err.message : 'could not switch version');
                        }
                      }}
                    >Make live</button>
                  )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
