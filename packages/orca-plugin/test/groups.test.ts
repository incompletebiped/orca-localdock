import { describe, it, expect } from 'vitest';
import { partialGroups, updateGroup } from '../src/shared/groups.js';

describe('update groups', () => {
  it('names what a file belongs to', () => {
    expect(updateGroup('wp-admin/about.php')).toBe('WordPress core');
    expect(updateGroup('wp-includes/version.php')).toBe('WordPress core');
    expect(updateGroup('wp-login.php')).toBe('WordPress core');
    expect(updateGroup('wp-config.php')).toBeNull();
    expect(updateGroup('wp-content/plugins/example-forms/includes/a.php')).toBe('plugin example-forms');
    expect(updateGroup('wp-content/mu-plugins/toolkit/autoload.php')).toBe('must-use plugin toolkit');
    expect(updateGroup('wp-content/themes/example-child/style.css')).toBe('theme example-child');
    expect(updateGroup('wp-content/plugins/hello.php')).toBeNull();
    expect(updateGroup('.htaccess')).toBeNull();
  });

  it('finds updates a selection only partly covers', () => {
    const all = ['wp-admin/about.php', 'wp-includes/version.php', 'wp-content/plugins/a/a.php', 'wp-content/plugins/a/b.php', 'wp-content/plugins/b/x.php', '.htaccess'];
    expect(partialGroups(['wp-admin/about.php', 'wp-content/plugins/b/x.php', '.htaccess'], all)).toEqual([{ group: 'WordPress core', selected: 1, total: 2 }]);
    expect(partialGroups(['wp-content/plugins/a/a.php', 'wp-content/plugins/a/b.php'], all)).toEqual([]);
  });
});
