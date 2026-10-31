// 绑定表与绑定行（决策 2026-10-31-im-owner-designation）：peer → 原生会话的
    // 列表、共享会话徽标、主人文案与主人控件入口。与主面板共用同一作用域
    // （manifest 里紧跟 97e 主人控件拼接）；`ImPeersBand` 由 97-ui-im.js 的
    // PanelIm 调用，拆到这里只为守住 97-ui-im.js 的 800 行源码预算。
    /** 绑定表 + 未绑定待办：对端 → 原生会话；未绑定的显示在最上面。 */
    function ImPeersBand({ peers, pendingPeers, owners, senders, sharedSessions, currentSession, sessionLabel, busy, onRebind, onBindPending, onUnbind, onSetOwner }) {
      const t = useTranslate()
      const current = typeof currentSession === 'string' ? currentSession : ''
      const empty = peers.length === 0 && pendingPeers.length === 0
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('im.peers.title')),
        h('p', { className: 'dt-hint' }, t('im.peers.hint')),
        pendingPeers.length > 0
          ? h('div', { className: 'dt-im-pending' },
            h('h4', null, t('im.pending.title')),
            h('p', { className: 'dt-hint' }, current === '' ? t('im.peers.noCurrentSession') : t('im.pending.hint')),
            pendingPeers.map((peer) => h('div', { key: peer.key, className: 'dt-im-pending-row', 'data-im-pending': peer.key },
              h('div', { className: 'dt-im-pending-copy' },
                h('code', { className: 'dt-im-peer-key' }, peer.alias),
                h('span', null, `${t(`im.channel.${peer.channel}`)} · ${t(peer.scope === 'group' ? 'im.scope.group' : 'im.scope.private')}${peer.senderName === undefined ? '' : ` · ${peer.senderName}`}`),
                h('span', { className: 'dt-hint' }, t('im.pending.lastAt', { at: new Date(peer.lastAt).toLocaleString() }))),
              h(Button, {
                size: 'sm',
                variant: 'outline',
                disabled: imPeerBusy(busy) || current === '',
                onClick: () => onBindPending(peer, current),
              }, t('im.pending.bind')))))
          : null,
        empty
          ? h('div', null,
            h('p', { className: 'dt-muted' }, t('im.peers.empty')),
            h('p', { className: 'dt-hint' }, t('im.peers.emptyHint')))
          : h('div', { className: 'dt-im-peers' }, peers.map((peer) => h(ImPeerRow, {
            key: peer.key,
            peer,
            shared: sharedSessions.has(peer.sessionId),
            owner: owners?.[peer.key] ?? null,
            senders: senders?.[peer.key] ?? [],
            currentSession: current,
            sessionLabel,
            disabled: imPeerBusy(busy),
            ownerDisabled: imOwnerBusy(busy),
            onRebind,
            onUnbind,
            onSetOwner,
          }))))
    }

    function ImPeerRow({ peer, shared, owner, senders, currentSession, sessionLabel, disabled, ownerDisabled, onRebind, onUnbind, onSetOwner }) {
      const t = useTranslate()
      const same = currentSession !== '' && peer.sessionId === currentSession
      return h('div', { className: 'dt-im-peer', 'data-im-peer': peer.key },
        h('div', { className: 'dt-im-peer-main' },
          h('div', { className: 'dt-im-peer-head' },
            h('code', { className: 'dt-im-peer-key' }, peer.key),
            h(Pill, null, t(peer.scope === 'group' ? 'im.scope.group' : 'im.scope.private')),
            shared ? h(Pill, { active: true }, t('im.peers.shared')) : null),
          h('p', { className: 'dt-im-peer-chat' },
            t('im.peers.session', { session: sessionLabel(peer.sessionId) }),
            shared ? ` · ${t('im.peers.sharedHint')}` : ''),
          peer.live === false ? h('p', { className: 'dt-hint dt-im-peer-closed' }, t('im.peers.closed')) : null,
          h('p', { className: 'dt-hint dt-im-owner-line' }, t('im.owner.label', { name: imOwnerNameOf(peer, owner ?? null, t) })),
          h(ImOwnerControls, {
            peer,
            owner: owner ?? null,
            senders: senders ?? [],
            disabled: ownerDisabled === true,
            onSetOwner,
          }),
          h('p', { className: 'dt-hint' }, t('im.peers.boundAt', { at: new Date(peer.createdAt).toLocaleString() }))),
        h('div', { className: 'dt-im-peer-actions' },
          h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: disabled || same || currentSession === '',
            onClick: () => onRebind(peer, currentSession),
          }, t('im.peers.rebindCurrent')),
          h(Button, { size: 'sm', variant: 'ghost', disabled, onClick: () => onUnbind(peer) }, t('im.peers.unbind'))))
    }