import re,sys
import os
src=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'../../apps/control-plane/src/lib/server/mcp.ts')).read()
names=re.findall(r"\n\ttool\(\s*\n?\s*'([a-z_]+)'",src)
areas=[
 ('Identity & docs',lambda n:n in('whoami','search_docs','read_docs')),
 ('Projects',lambda n:n in('list_projects','get_project','create_project','update_project','delete_project','delete_projects','restore_projects','get_operation')),
 ('Deploy',lambda n:n in('deploy_site','deploy_files','create_upload','finalize_upload')),
 ('Releases',lambda n:n in('list_deployments','get_deployment','promote_deployment','rollback')),
 ('Environments',lambda n:'environment' in n),
 ('Workloads & functions',lambda n:n in('get_workload','set_workload','get_node_capacity') or 'function' in n),
 ('Volumes',lambda n:n.endswith('_volume') or n.endswith('_volumes') or 'volume_snapshot' in n),
 ('Jobs',lambda n:n.endswith('_job') or n.endswith('_jobs') or 'job_run' in n or n=='run_command'),
 ('Containers (while the feature is on)',lambda n:n.endswith('_container') or 'container_file' in n),
 ('Databases & backups',lambda n:'database' in n or 'backup_target' in n),
 ('Brokers & queues',lambda n:'broker' in n or 'queue' in n or n=='get_node_task'),
 ('Event rules',lambda n:'event_' in n),
 ('Storage',lambda n:'storage' in n or 'object' in n or 'bucket' in n),
 ('Access',lambda n:n in('set_access','create_share_link','list_share_links','revoke_share_link') or 'site_session' in n or n=='sign_out_all_visitors'),
 ('Observe',lambda n:n in('get_status','get_metrics','get_logs','get_audit_log') or 'log_drain' in n),
 ('Dashboards',lambda n:'dashboard' in n or 'telemetry' in n),
 ('Alerts',lambda n:'alert' in n),
 ('Email (while the feature is on)',lambda n:'email' in n),
 ('Blueprints',lambda n:n in('plan_stack','apply_stack','get_task')),
 ('Platform',lambda n:n in('list_nodes','get_usage','get_quotas','restart_services','get_ha_status')),
]
out={a:[] for a,_ in areas}; unk=[]
for n in names:
  for a,f in areas:
    if f(n): out[a].append(n); break
  else: unk.append(n)
print(len(names),'tools; unknown:',unk, 'dupes:',[n for n in set(names) if names.count(n)>1], file=sys.stderr)
print('| Area | Tools |\n|---|---|')
for a,_ in areas:
  if out[a]: print(f"| {a} | "+' · '.join(f'`{n}`' for n in out[a])+' |')
