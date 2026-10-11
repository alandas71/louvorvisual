'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let token = '';
  try { token = sessionStorage.getItem('lv-phone-token') || ''; } catch { /* Vale até fechar esta página. */ }
  let state = null, online = false, busy = false, timer, libraryBusy = false;
  let kind = 'songs', setlistId = null, entries = [], cursor = null, selectedSession = undefined;
  const uuid = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  };
  const saveToken = value => { token = value; try { value ? sessionStorage.setItem('lv-phone-token', value) : sessionStorage.removeItem('lv-phone-token'); } catch { /* Memória desta página. */ } };
  async function api(path, body, timeout = 4000) {
    const abort = new AbortController(), limit = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? {'X-LouvorVisual-Token':token} : {}) }, body: body ? JSON.stringify(body) : undefined, cache:'no-store', signal:abort.signal });
      const data = await response.json();
      if (!response.ok) { const error = new Error(data.message || 'Não foi possível atender.'); error.status = response.status; throw error; }
      return data;
    } finally { clearTimeout(limit); }
  }
  const feedback = message => { $('feedback').textContent = message; };
  function controls() {
    const selected = selectedSession === undefined;
    const active = online && selected && !busy && state && state.sessionId && !['loading','error','idle'].includes(state.phase);
    for (const button of document.querySelectorAll('[data-command]')) button.disabled = !active;
    $('start').hidden = state?.phase !== 'ready';
    $('previous').disabled = !active || state.phase === 'ready' || state.index <= 0;
    $('next').disabled = !active || state.phase === 'ready' || state.index >= state.total - 1;
    $('toggle').disabled = !active || state.phase === 'ready' || !state.transport;
    $('toggle').textContent = state?.phase === 'paused' ? 'Retomar' : 'Pausar / retomar';
    $('black').textContent = state?.visualMode === 'black' ? 'Mostrar letras' : 'Apagar tela';
    $('black').setAttribute('aria-pressed', String(state?.visualMode === 'black'));
    for (const button of $('library').querySelectorAll('button')) button.disabled = !online || busy || !selected;
  }
  async function poll() {
    if (!token) return;
    try {
      const result = await api('/status');
      state = result.presentation; online = result.foreground;
      if (selectedSession !== undefined && ((state.sessionId !== selectedSession && !['idle','loading'].includes(state.phase)) || state.phase === 'error')) selectedSession = undefined;
      $('pairing').hidden = true; $('control').hidden = false;
      $('connection').textContent = online ? 'Conectado ao projetor' : 'Abra o LouvorVisual no projetor para continuar.';
      $('title').textContent = state.title || 'Escolha um louvor';
      const labels = {ready:'Preparado · toque em Iniciar',running:'Em apresentação',paused:'Em pausa',finished:'Fim dos slides',loading:'Preparando louvor…',idle:'Nenhuma apresentação ativa',error:'Falha ao preparar'};
      $('slide-info').textContent = (labels[state.phase] || '') + (state.total ? ' · Slide '+(state.index+1)+' de '+state.total : '');
      $('preview').textContent = state.text || 'Escolha um louvor da biblioteca abaixo.';
      $('preview').dataset.black = String(state.visualMode === 'black');
      $('notice').textContent = state.visualMode === 'black' ? 'A tela do projetor está apagada. Esta é a prévia das letras.' : state.message || '';
    } catch (error) {
      online = false;
      if (error.status === 401) { saveToken(''); $('pairing').hidden = false; $('control').hidden = true; feedback(error.message); }
      $('connection').textContent = 'Sem conexão. Confira o Wi-Fi e mantenha o LouvorVisual aberto no projetor.';
    }
    controls();
    clearTimeout(timer); if (token) timer = setTimeout(poll, 1000);
  }
  async function send(command) {
    if (busy || !online) return;
    busy = true; feedback(''); controls();
    try {
      const answer = await api('/command', {id:uuid(), command}, 14000);
      if (!answer.ok) throw new Error(answer.message);
      if (command.type === 'select') selectedSession = state?.sessionId ?? null;
      await poll();
    } catch (error) { feedback(error.name === 'AbortError' ? 'O comando não foi confirmado. Confira a prévia antes de tentar de novo.' : error.message); }
    finally { busy = false; controls(); }
  }
  function renderLibrary() {
    $('library').replaceChildren();
    const search = $('search').value.toLocaleLowerCase('pt-BR');
    for (const item of entries.filter(item => item.title.toLocaleLowerCase('pt-BR').includes(search))) {
      const button = document.createElement('button');
      button.textContent = item.title + (kind === 'setlists' ? ' · '+item.itemCount+' louvores' : ' · '+item.slideCount+' slides');
      button.addEventListener('click', () => {
        if (!online || busy || selectedSession !== undefined) return;
        if (kind === 'setlists') { kind = 'setlist'; setlistId = item.setlistId; $('search').value = ''; void loadLibrary(); }
        else void send({type:'select',arrangementId:item.arrangementId,setlistId:kind === 'setlist' ? setlistId : null,itemId:kind === 'setlist' ? item.itemId : null});
      });
      $('library').append(button);
    }
    $('more').hidden = cursor === null;
    $('songs').setAttribute('aria-pressed',String(kind === 'songs'));
    $('setlists').setAttribute('aria-pressed',String(kind !== 'songs'));
    controls();
  }
  async function loadLibrary(more = false) {
    if (libraryBusy || !token) return;
    libraryBusy = true; $('library-status').textContent = 'Carregando…';
    try {
      const query = new URLSearchParams({kind});
      if (setlistId && kind === 'setlist') query.set('id',setlistId);
      if (more && cursor) query.set('cursor',cursor);
      const data = await api('/library?'+query);
      entries = more ? entries.concat(data.items) : data.items; cursor = data.nextCursor ?? null;
      $('library-status').textContent = data.setlist ? data.setlist.title : entries.length ? entries.length+' itens carregados' : 'Nenhum item. Importe um pacote no projetor.';
      renderLibrary();
    } catch (error) { $('library-status').textContent = error.message; }
    finally { libraryBusy = false; }
  }
  $('pair-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; feedback('');
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { const result = await api('/pair',{code:$('code').value.trim()}); saveToken(result.token); await poll(); await loadLibrary(); }
    catch (error) { feedback(error.name === 'AbortError' ? 'Não foi possível conectar. Confira o endereço e o Wi-Fi.' : error.message); }
    finally { busy = false; button.disabled = false; controls(); }
  });
  for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => {
    if (!state?.sessionId) return;
    let type = button.dataset.command;
    if (type === 'end' && !confirm('Encerrar a apresentação no projetor?')) return;
    if (type === 'black' && state.visualMode === 'black') type = 'normal';
    void send({type,sessionId:state.sessionId});
  });
  $('songs').addEventListener('click', () => { if(libraryBusy)return;kind='songs';setlistId=null;$('search').value='';void loadLibrary(); });
  $('setlists').addEventListener('click', () => { if(libraryBusy)return;kind='setlists';setlistId=null;$('search').value='';void loadLibrary(); });
  $('search').addEventListener('input',renderLibrary);
  $('more').addEventListener('click',() => void loadLibrary(true));
  $('refresh').addEventListener('click',() => void loadLibrary());
  $('disconnect').addEventListener('click',() => { saveToken('');online=false;clearTimeout(timer);$('control').hidden=true;$('pairing').hidden=false;$('connection').textContent='Celular desconectado. Gere um novo código no projetor para reconectar.'; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token) { clearTimeout(timer); void poll(); } });
  if (token) void poll().then(() => loadLibrary()); else $('connection').textContent = 'Aguardando o código do projetor';
})();
