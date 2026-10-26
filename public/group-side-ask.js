import {createSideAsk} from './native-side-ask.js';
import {t} from './i18n.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
/** A card supplies only its identity. Home resolves the immutable execution, never the role's current binding. */
export function createGroupSideAsk({api,getData,show,onError,getScope}){
 const panel=document.querySelector('#inspector-ask'),source=el('div','group-ask-source'),name=el('strong','',t('Choose an Agent card to start a side question')),quote=el('p','group-ask-quote'),hint=el('p','workspace-note',t('Starts from the original session’s context; later main-session messages do not change this side conversation.'));
 source.append(name,quote,hint);const chat=createSideAsk({api,getData,getModel:s=>s.model});const scopeNote=el('p','workspace-note group-ask-scope');scopeNote.hidden=true;panel.append(source,scopeNote,chat.root);chat.root.hidden=true;hint.hidden=true;
 const clear=chat.clear;clear.hidden=true;document.querySelector('.inspector-header').append(clear);
 let key='',loading=false,sourceScope=null;
 function syncScope(){const away=Boolean(sourceScope&&JSON.stringify(getScope())!==sourceScope);source.hidden=away;chat.root.hidden=away||!key;scopeNote.hidden=!away;scopeNote.textContent=t('This side question belongs to another group chat. Return to that chat to continue, or clear it here.');}
 clear.addEventListener('click',()=>{if(sourceScope&&JSON.stringify(getScope())!==sourceScope){chat.detach();key='';sourceScope=null;name.textContent=t('Choose an Agent card to start a side question');quote.textContent='';hint.hidden=true;syncScope();}});
 return {clear,syncScope,
  async open(message){
   if(loading)return;
   const next=JSON.stringify([message.projectId,message.conversationId||message.projectId,message.id]);
   if(next===key){syncScope();show();chat.focus();return;}
   if(chat.hasUnsentOrBusy()&&!window.confirm(t('Switch side questions? The current draft or answer will be cleared. The main task will keep running.')))return;
   const scope=JSON.stringify(getScope());loading=true;chat.setSourceLoading(true);
   try{
    const sideEndpoint=`/api/projects/${encodeURIComponent(message.projectId)}/${message.sideRunId?'runs':'messages'}/${encodeURIComponent(message.sideRunId||message.id)}/side`;
    const value=await api(`${sideEndpoint}?${new URLSearchParams({conversationId:message.conversationId||message.projectId})}`);
    if(scope!==JSON.stringify(getScope()))return;
    hint.textContent=t(value.previousRunId?'Based on the previous completed question and reply. Files are still current.':'Starts from the original session’s context; later main-session messages do not change this side conversation.');hint.hidden=false;key=next;sourceScope=JSON.stringify([value.projectId,value.conversationId]);chat.attach({...value,sourceKey:key,sideEndpoint});name.textContent=t('Side question with {name}',{name:value.senderName});quote.textContent=value.quote;quote.title=value.quote;syncScope();show();chat.focus();
   }catch(error){onError(error.message);}finally{loading=false;chat.setSourceLoading(false);}
  }
 };
}
