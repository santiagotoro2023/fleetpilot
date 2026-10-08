# FleetPilot: an Ansible callback that writes every event as one JSON line (FPJSON …), so the
# app server can show live progress per host and task. Part of FleetPilot, not a dependency.
from __future__ import annotations

import json
import sys

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = '''
    name: fleetpilot
    type: stdout
    short_description: JSON lines for FleetPilot
    description: Every play, task and result as one JSON object per line.
'''

LIMIT = 4000


def _cut(value):
    if value is None:
        return ''
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= LIMIT else text[:LIMIT] + '\n…'


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = 'stdout'
    CALLBACK_NAME = 'fleetpilot'

    def _emit(self, **event):
        sys.stdout.write('FPJSON ' + json.dumps(event, default=str) + '\n')
        sys.stdout.flush()

    def v2_playbook_on_play_start(self, play):
        self._emit(event='play', name=play.get_name())

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._emit(event='task', name=task.get_name())

    def v2_playbook_on_handler_task_start(self, task):
        self._emit(event='task', name=task.get_name(), handler=True)

    def _result(self, status, result, ignored=False):
        r = result._result
        hidden = r.get('_ansible_no_log') or getattr(result._task, 'no_log', False)
        event = dict(event='result', status=status, host=result._host.get_name(), task=result._task.get_name(),
                     changed=bool(r.get('changed')), ignored=ignored)
        if hidden:
            event['msg'] = 'Details hidden: this task handles secrets.'
        else:
            event['msg'] = _cut(r.get('msg') or (r.get('stderr') if status == 'failed' else '') or '')
            if r.get('stdout') and status != 'skipped':
                event['stdout'] = _cut(r.get('stdout'))
            if r.get('stderr') and status == 'failed':
                event['stderr'] = _cut(r.get('stderr'))
            diff = r.get('diff')
            if diff:
                diffs = diff if isinstance(diff, list) else [diff]
                event['diff'] = [dict(path=d.get('after_header') or d.get('before_header') or '', before=_cut(d.get('before')), after=_cut(d.get('after')))
                                 for d in diffs if isinstance(d, dict) and (d.get('before') != d.get('after'))]
            if r.get('ansible_facts') and result._task.action in ('setup', 'ansible.builtin.setup', 'gather_facts', 'ansible.builtin.gather_facts'):
                f = r['ansible_facts']
                event['facts'] = {k: f.get(k, f.get('ansible_' + k)) for k in ('distribution', 'distribution_version', 'distribution_release', 'os_family', 'kernel', 'architecture',
                                                        'processor_vcpus', 'memtotal_mb', 'fqdn', 'hostname', 'default_ipv4', 'all_ipv4_addresses',
                                                        'all_ipv6_addresses', 'virtualization_type', 'virtualization_role', 'uptime_seconds', 'interfaces',
                                                        'product_name', 'system_vendor')}
            if r.get('content') and result._task.action in ('slurp', 'ansible.builtin.slurp'):
                event['content'] = r.get('content')
        self._emit(**event)

    def v2_runner_on_ok(self, result):
        self._result('changed' if result._result.get('changed') else 'ok', result)

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._result('failed', result, ignored=ignore_errors)

    def v2_runner_on_skipped(self, result):
        self._result('skipped', result)

    def v2_runner_on_unreachable(self, result):
        self._result('unreachable', result)

    def v2_runner_item_on_failed(self, result):
        self._result('failed', result)

    def v2_playbook_on_stats(self, stats):
        for host in sorted(stats.processed.keys()):
            s = stats.summarize(host)
            self._emit(event='stats', host=host, ok=s['ok'], changed=s['changed'], failed=s['failures'], unreachable=s['unreachable'], skipped=s['skipped'])

    def v2_playbook_on_no_hosts_matched(self):
        self._emit(event='warning', msg='No hosts matched.')
