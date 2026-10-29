import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Card, Empty, Input, Select, Space, Spin, Table, Tag, Typography, message } from 'antd'
import { ReloadOutlined, DownloadOutlined, FileTextOutlined } from '@ant-design/icons'
import { api } from '../api/client'
import type { NodeLogFile } from '../api/logs'

type Task={node_id:string;task_id:string|null;name:string;status:string}
type Run={project_id:string;project_name:string;run_id:string;job_id:string;status:string;created_at:string;tasks:Task[];outputs:{name:string;path:string;task_name:string}[]}
const root='/portal/project-runs'
const labels:Record<string,string>={succeeded:'已完成',failed:'失败',running:'执行中',accepted:'已接收','pending-dispatch':'等待调度',pending:'等待中',cancelled:'已取消',unknown:'待确认'}
const status=(s:string)=><Tag color={s==='succeeded'?'green':s==='failed'?'red':s==='running'?'blue':undefined}>{labels[s]||'待确认'}</Tag>
const errorText=(e:any)=>e?.response?.data?.detail||e.message||'操作失败'
export default function ProjectRuns(){
 const [searchParams]=useSearchParams()
 const [offset,setOffset]=useState(0),[runId,setRunId]=useState<string>(),[executionId,setExecutionId]=useState(searchParams.get('execution')||''),[busy,setBusy]=useState(false),[resolved,setResolved]=useState<Run>(),[taskId,setTaskId]=useState<string>(),[logPath,setLogPath]=useState<string>(),[lines,setLines]=useState<string[]>(),[logBusy,setLogBusy]=useState(false),[search,setSearch]=useState('')
 const runs=useQuery({queryKey:['project-runs',offset],queryFn:()=>api.get<unknown,Run[]>(root,{params:{offset}}),refetchInterval:15000})
 const run=useQuery({queryKey:['project-run',runId],queryFn:()=>api.get<unknown,Run>(root+'/'+runId),enabled:!!runId,refetchInterval:15000})
 const current=run.data||resolved
 const logs=useQuery({queryKey:['project-task-logs',runId,taskId],queryFn:()=>api.get<unknown,NodeLogFile[]>(root+'/'+runId+'/logs',{params:{task_id:taskId}}),enabled:!!runId&&!!taskId})
 useEffect(()=>{setTaskId(undefined);setLogPath(undefined);setLines(undefined)},[runId])
 useEffect(()=>{setLogPath(undefined);setLines(undefined)},[taskId])
 const resolve=async()=>{setBusy(true);try{const found=await api.post<unknown,Run>(root+'/resolve',{execution_id:executionId.trim()});setResolved(found);setRunId(found.run_id);setExecutionId('')}catch(e){message.error(errorText(e))}finally{setBusy(false)}}
 const download=async(path:string)=>{if(current?.status!=='succeeded')return;try{const value=await api.post<unknown,{ticket:string}>(root+'/'+runId+'/download-ticket',{path});window.location.assign('/portal/files/download?ticket='+encodeURIComponent(value.ticket))}catch(e){message.error(errorText(e))}}
 const loadLog=async(path=logPath)=>{if(!path||!taskId)return;setLogBusy(true);try{const value=await api.post<unknown,{lines:string[]}>(root+'/'+runId+'/logs/tail',{task_id:taskId,path,lines:500});setLines(value.lines);setLogPath(path)}catch(e){message.error(errorText(e))}finally{setLogBusy(false)}}
 return <div className="project-runs-page">
  <header className="project-runs-heading"><div><Typography.Title level={3}>项目运行</Typography.Title><Typography.Text type="secondary">本连接器参与的计算任务、日志与输出结果</Typography.Text></div><Button icon={<ReloadOutlined/>} onClick={()=>{runs.refetch();run.refetch();logs.refetch()}}>刷新</Button></header>
  <section className="project-code-entry"><div><strong>执行请求编号</strong><span>登录参与方账号后，输入中心的执行请求编号定位日志与结果。</span></div><Input aria-label="执行请求编号" placeholder="输入执行请求编号" value={executionId} onChange={e=>setExecutionId(e.target.value)} onPressEnter={resolve} autoComplete="off"/><Button type="primary" disabled={!executionId.trim()} loading={busy} onClick={resolve}>定位结果</Button></section>
  <div className="project-runs-workspace"><aside className="project-run-list" aria-label="执行批次"><Input.Search placeholder="搜索项目名称" value={search} onChange={e=>setSearch(e.target.value)}/>{runs.isLoading&&<Spin/>}{runs.isError&&<Alert type="error" message={errorText(runs.error)}/>}{(runs.data||[]).filter(r=>r.project_name.includes(search)).map(r=><button className={`project-run-item ${r.run_id===runId?'active':''}`} key={r.run_id} onClick={()=>{setResolved(undefined);setRunId(r.run_id)}}><strong>{r.project_name}</strong><span>{new Date(r.created_at).toLocaleString()}</span><span>{status(r.status)}{r.tasks.length} 个本地任务 · {r.outputs.length} 项输出</span></button>)}{!runs.isLoading&&!runs.data?.length&&<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无本地执行记录"/>}<Space><Button size="small" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</Button><Button size="small" disabled={(runs.data?.length||0)<50} onClick={()=>setOffset(offset+50)}>下一页</Button></Space></aside>
  <main className="project-run-detail">{run.isError?<Alert type="error" message={errorText(run.error)}/>:!current?<Empty description="选择执行批次，或输入执行请求编号"/>:<>
   <div className="project-run-summary"><div><Typography.Title level={4}>{current.project_name}</Typography.Title>{status(current.status)}<Typography.Text type="secondary">{new Date(current.created_at).toLocaleString()}</Typography.Text></div><details><summary>执行请求编号</summary><Typography.Text copyable>{current.job_id}</Typography.Text></details></div>
   <Card title="输出结果" size="small">{current.outputs.length?<Table size="small" pagination={false} rowKey="path" dataSource={current.outputs} columns={[{title:'结果文件',dataIndex:'name'},{title:'输出任务',dataIndex:'task_name'},{title:'操作',render:(_,o)=><Button type="link" disabled={current.status!=='succeeded'} title={current.status!=='succeeded'?'运行成功完成后可下载结果':undefined} icon={<DownloadOutlined/>} onClick={()=>download(o.path)}>下载</Button>}]}/>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本连接器无正式结果文件；运行尚未完成或结果由其他参与方持有。"/>}</Card>
   <Card title="任务与日志" size="small"><Table size="small" pagination={false} rowKey="node_id" dataSource={current.tasks} columns={[{title:'任务',render:(_,t)=><div><strong>{t.name}</strong><details><summary>KusciaTask 号</summary><Typography.Text copyable>{t.task_id||'待同步'}</Typography.Text></details></div>},{title:'状态',dataIndex:'status',render:status},{title:'日志',render:(_,t)=><Button icon={<FileTextOutlined/>} disabled={!t.task_id} onClick={()=>setTaskId(t.task_id!)}>查看日志</Button>}]}/>
   {taskId&&<section className="project-task-log" aria-label="任务日志"><Space wrap><Typography.Text strong>{current.tasks.find(t=>t.task_id===taskId)?.name}</Typography.Text><Select aria-label="任务日志文件" placeholder="选择容器日志" value={logPath} loading={logs.isFetching} style={{minWidth:240,maxWidth:'100%'}} options={(logs.data||[]).map(f=>({value:f.path,label:`${f.pod?.container||f.name}${f.rotated?' · 历史日志':''}`}))} onChange={value=>loadLog(value)}/><Button onClick={()=>loadLog()} disabled={!logPath} loading={logBusy}>刷新日志</Button></Space>{logs.isError&&<Alert type="error" message={errorText(logs.error)}/>} {!logs.isFetching&&!logs.isError&&!logs.data?.length&&<Alert type="info" message="暂无可读取的任务日志" description="任务可能尚未启动，或节点已轮转、清理日志。可复制任务号到节点日志页面核查。"/>}{lines&&<pre tabIndex={0} aria-label="日志内容">{lines.join('\n')||'日志内容为空'}</pre>}</section>}</Card>
  </>}</main></div>
 </div>
}
