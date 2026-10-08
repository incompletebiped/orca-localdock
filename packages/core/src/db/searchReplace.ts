import { urlVariants } from './sqlDump.js';

export interface DbConnection {
  /** Hostname, or `localhost` for the default socket. */
  host: string;
  port?: number;
  socket?: string;
  name: string;
  user: string;
  password: string;
}

/**
 * Pairs to replace when moving a site from `fromUrl` to `toUrl`: http and
 * https variants of the source, plus their JSON-escaped forms
 * (`https:\/\/example.com`, used by page builders such as Elementor).
 */
export function urlReplacePairs(fromUrl: string, toUrl: string): Array<[string, string]> {
  const to = toUrl.replace(/\/$/, '');
  const pairs: Array<[string, string]> = [];
  for (const from of urlVariants(fromUrl)) {
    if (from === to) continue;
    pairs.push([from, to]);
    pairs.push([from.replace(/\//g, '\\/'), to.replace(/\//g, '\\/')]);
  }
  return pairs;
}

/**
 * A PHP script that performs a serialization-safe search-replace over the
 * text columns of `tables`, like `wp search-replace`. Values that are PHP
 * serialized are unserialized (objects disabled, to rule out object
 * injection from database content), replaced recursively and re-serialized,
 * so byte counts stay correct. Uses mysqli, which every WordPress host has
 * (the official wordpress image has no pdo_mysql). The posts `guid` column is left alone, as
 * WordPress recommends.
 *
 * Parameters (including the DB password) are embedded as base64 JSON. The
 * script is meant to be sent on php's stdin, never written to disk or passed
 * on a command line. Prints one JSON line: {"ok":true,"rows":N} or {"ok":false,"error":"…"}.
 */
export function searchReplaceScript(params: {
  db: DbConnection;
  tables: readonly string[];
  tablePrefix: string;
  pairs: ReadonlyArray<[string, string]>;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      db: params.db,
      tables: params.tables,
      prefix: params.tablePrefix,
      from: params.pairs.map((p) => p[0]),
      to: params.pairs.map((p) => p[1]),
    }),
    'utf-8',
  ).toString('base64');

  return `<?php
error_reporting(E_ALL & ~E_DEPRECATED);
ini_set('display_errors', 'stderr');
$p = json_decode(base64_decode('${payload}'), true);
function ld_replace($d, $from, $to) {
  if (is_array($d)) {
    $out = array();
    foreach ($d as $k => $v) {
      $out[is_string($k) ? str_replace($from, $to, $k) : $k] = ld_replace($v, $from, $to);
    }
    return $out;
  }
  if (!is_string($d)) { return $d; }
  // Some plugins store serialized data inside serialized data; recurse so inner byte counts stay right.
  $inner = @unserialize($d, array('allowed_classes' => false));
  if ($inner !== false || $d === 'b:0;') { return serialize(ld_replace($inner, $from, $to)); }
  return str_replace($from, $to, $d);
}
try {
  $db = $p['db'];
  mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
  $host = empty($db['socket']) ? trim($db['host'], '[]') : 'localhost';
  $m = new mysqli($host, $db['user'], $db['password'], $db['name'], empty($db['port']) ? 3306 : (int) $db['port'], empty($db['socket']) ? null : $db['socket']);
  $m->set_charset('utf8mb4');
  $total = 0;
  foreach ($p['tables'] as $t) {
    if (!preg_match('/^[A-Za-z0-9_]+$/', $t)) { throw new Exception('bad table name'); }
    $pk = null; $cols = array();
    $res = $m->query("SHOW COLUMNS FROM \`$t\`");
    while ($c = $res->fetch_assoc()) {
      if ($c['Key'] === 'PRI' && $pk === null) { $pk = $c['Field']; }
      if (preg_match('/char|text/i', $c['Type'])) { $cols[] = $c['Field']; }
    }
    if ($pk === null) { continue; }
    foreach ($cols as $col) {
      if ($col === $pk || ($t === $p['prefix'] . 'posts' && $col === 'guid')) { continue; }
      $likes = array();
      foreach ($p['from'] as $f) { $likes[] = "\`$col\` LIKE '%" . $m->real_escape_string(addcslashes($f, '\\%_')) . "%'"; }
      $rows = $m->query("SELECT \`$pk\` AS id, \`$col\` AS v FROM \`$t\` WHERE " . implode(' OR ', $likes))->fetch_all(MYSQLI_ASSOC);
      $upd = $m->prepare("UPDATE \`$t\` SET \`$col\` = ? WHERE \`$pk\` = ?");
      foreach ($rows as $r) {
        $raw = $r['v'];
        if ($raw === null) { continue; }
        $dec = @unserialize($raw, array('allowed_classes' => false));
        if ($dec !== false || $raw === 'b:0;') {
          $new = serialize(ld_replace($dec, $p['from'], $p['to']));
        } else {
          $new = str_replace($p['from'], $p['to'], $raw);
        }
        if ($new !== $raw) { $id = (string) $r['id']; $upd->bind_param('ss', $new, $id); $upd->execute(); $total++; }
      }
    }
  }
  echo json_encode(array('ok' => true, 'rows' => $total)), "\\n";
} catch (Throwable $e) {
  echo json_encode(array('ok' => false, 'error' => $e->getMessage())), "\\n";
  exit(1);
}
`;
}

/** Parse the script's JSON result line. */
export function parseSearchReplaceOutput(stdout: string): { ok: true; rows: number } | { ok: false; error: string } {
  const line = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  if (!line) return { ok: false, error: stdout.trim() || 'no output from PHP' };
  try {
    const r = JSON.parse(line) as { ok: boolean; rows?: number; error?: string };
    return r.ok ? { ok: true, rows: r.rows ?? 0 } : { ok: false, error: r.error ?? 'unknown error' };
  } catch {
    return { ok: false, error: line };
  }
}
