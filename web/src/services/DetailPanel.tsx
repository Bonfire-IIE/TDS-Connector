import { Collapse, Empty, Pagination, Tag } from 'antd'
import { useState } from 'react'

const labels: Record<string, string> = {
 id:'标识', name:'名称', logical_name:'对象名称', resource_name:'资源名称', resource_abstract:'资源摘要', metadata:'目录元数据', data_items:'信息项', columns:'字段结构', items:'明细记录', versions:'历史版本', audit:'审计记录', events:'事件记录', state:'执行状态', status:'状态', phase:'执行阶段', mode:'任务类型', kind:'类型', version:'版本', version_no:'版本', revision:'修订号', created_at:'创建时间', updated_at:'更新时间', source_id:'数据源标识', source_ref:'输入引用', source_refs:'输入对象', object_ref:'源对象', resource_id:'资源标识', target_id:'目标数据源', target_path:'目标目录', input:'输入配置', output:'输出配置', plan:'执行计划', config:'连接配置', resource_owner_name:'持有方', resource_owner_id:'持有方标识', contact_name:'联系人', contact_information:'联系电话', industry_code:'行业分类', theme_code:'政务主题', data_type:'数据类型', data_source_type:'数据来源', security_level:'安全等级', personal_information_level:'个人信息等级', update_frequency:'更新频率', update_method:'更新方式', data_size:'数据规模', time_range:'时间范围', annotation_info:'标注信息', data_modalities:'数据模态', ai_task_types:'AI 任务', error:'错误信息', last_error:'最近错误', message:'说明', reason:'原因', review_comment:'审核意见', attempts:'重试次数', next_attempt:'下次重试', last_success:'最近同步成功', synchronization:'同步情况', publication:'中心投影', published_at:'提交时间', deleted_at:'删除时间', retryable:'允许重试', total:'总数', next_cursor:'后续分页标记', next_offset:'后续分页位置', type:'字段类型', comment:'字段说明', nullable:'允许为空', size:'字节数', bytes:'字节数', checksum:'校验值', sha256:'SHA-256', warehouse_ref:'所属仓库', warehouse_id:'仓库标识', bucket:'存储桶', endpoint:'存储地址', provider:'存储类型', physical_versions:'物理版本', version_id:'物理版本标识', retention_policy_ref:'保留策略', retain_days:'保留天数', grace_hours:'宽限小时', expires_at:'到期时间', valid_from:'生效时间', valid_to:'失效时间', subject:'消费主体', purpose:'用途', project_ref:'项目引用', contract_ref:'合约引用', business_task_ref:'业务任务编号', object_id:'对象标识', access_mode:'访问方式', url:'访问地址', credentials:'临时凭据', access_key_id:'访问密钥标识', secret_access_key:'访问密钥', session_token:'会话令牌', username:'用户名', password:'密码', host:'主机', port:'端口', directory:'目录', files:'文件列表', received_files:'已接收文件', path:'路径', rows:'行数', result:'执行结果', outputs:'输出结果', actor:'操作主体', action:'操作', timestamp:'发生时间', payload:'事件内容', details:'详细信息', resource_format:'资源格式', format:'格式', input_format:'输入格式', output_format:'输出格式', classification:'数据等级', lease_seconds:'租约秒数', ttl_seconds:'有效秒数', max_uses:'使用次数上限', uses:'已用次数', outbox_pending:'待发布事件', dead_jobs:'失败任务', objects:'对象数量', token:'访问令牌', access_key_secret:'访问密钥', resource_quality:'数据质量', high_quality_flag:'高质量数据集', ai_readiness:'AI 就绪度', contains_synthetic_data:'包含合成数据', ai_training_authorization:'AI 训练授权', scale:'标注规模', quality:'标注质量', types:'标注类型'
}
const states: Record<string,string> = {registered:'本地已登记',pending_review:'中心待审核',published:'中心已审核',rejected:'中心已驳回',delisted:'中心投影已撤回',publish_failed:'提交失败',created:'已创建',queued:'排队中',running:'执行中',succeeded:'已完成',failed:'失败',cancelled:'已取消',ready:'准备完成',available:'可用',unavailable:'不可用','structured-file':'结构化文件','binary-file':'二进制文件',database:'数据库'}
const sections = [
 { title:'基本信息', match:/^(id|name|logical_name|resource_name|resource_abstract|state|status|phase|mode|kind|version|version_no|revision|format|resource_format|total)$/ },
 { title:'数据来源与交付', match:/(source|target|object|warehouse|bucket|endpoint|path|format|size|bytes|checksum|sha256)/ },
 { title:'持有方与分类', match:/(owner|contact|industry|theme|security|personal|classification|data_type)/ },
 { title:'授权与保留', match:/(subject|purpose|project|contract|retention|retain|grace|lease|ttl|max_uses|access_mode)/ },
 { title:'执行与同步', match:/(error|attempt|retry|success|review|message|reason)/ },
 { title:'时间记录', match:/(_at$|^valid_|timestamp|time_range)/ },
]
function Value({name,value}:{name:string;value:any}) {
 if(value===null || value===undefined || value==='')return <span className="detail-muted">未提供</span>
 if(typeof value==='boolean')return <span>{value?'是':'否'}</span>
 if(['state','status','phase','mode'].includes(name))return <Tag>{states[String(value)] || String(value)}</Tag>
 if(/(_at$|^valid_|timestamp|next_attempt|last_success)/.test(name)) {
  const date=new Date(typeof value==='number'?value*1000:value)
  if(!Number.isNaN(date.getTime())) return <span>{date.toLocaleString()}</span>
 }
 return <span>{String(value)}</span>
}
function Records({value}:{value:any[]}) {
 const [page,setPage]=useState(1)
 if(!value.length)return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
 return <div className="detail-records">{value.slice((page-1)*5,page*5).map((item,i)=><article className="detail-record" key={i}><h4>{item?.resource_name || item?.logical_name || item?.name || `记录 ${(page-1)*5+i+1}`}</h4><DetailPanel value={item}/></article>)}{value.length>5&&<Pagination current={page} pageSize={5} total={value.length} showSizeChanger={false} onChange={setPage}/>}</div>
}
export default function DetailPanel({value}:{value:any}) {
 if(value==null)return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据"/>
 if(Array.isArray(value))return <Records value={value}/>
 if(typeof value!=='object')return <div className="detail-scalar">{String(value)}</div>
 const entries=Object.entries(value).filter(([k])=>!['next_cursor','next_offset'].includes(k))
 const scalar=entries.filter(([,v])=>v===null||typeof v!=='object')
 const nested=entries.filter(([,v])=>v!==null&&typeof v==='object')
 const known=scalar.filter(([k])=>labels[k])
 const unknown=scalar.filter(([k])=>!labels[k])
 const used=new Set<string>()
 const groups=sections.map(section=>({title:section.title,items:known.filter(([k])=>{if(used.has(k)||!section.match.test(k))return false;used.add(k);return true})}))
 groups.push({title:'补充信息',items:known.filter(([k])=>!used.has(k))})
 return <div className="business-detail">{groups.filter(g=>g.items.length).map(g=><section className="detail-section" key={g.title}><h3>{g.title}</h3><dl>{g.items.map(([k,v])=><div key={k} className={/abstract|error|message|url|token|secret|password/.test(k)?'detail-wide':''}><dt>{labels[k]}</dt><dd><Value name={k} value={v}/></dd></div>)}</dl></section>)}{nested.map(([k,v])=><section className="detail-section detail-nested" key={k}><h3>{labels[k]||k}</h3><DetailPanel value={v}/></section>)}{!!unknown.length&&<Collapse size="small" items={[{key:'extra',label:'其他技术字段',children:<dl className="detail-extra">{unknown.map(([k,v])=><div key={k}><dt>{k}</dt><dd><Value name={k} value={v}/></dd></div>)}</dl>}]}/>}</div>
}
