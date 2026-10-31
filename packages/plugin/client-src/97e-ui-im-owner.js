// 会话主人（决策 2026-10-31-im-owner-designation）：绑定行上的主人标签与选择器。
    // 投影来源：`owners[peerKey]`（`snd-` 哈希 + 昵称）与 `senders[peerKey]`（最近发言人，
    // 已哈希），私聊绑定行多一个 `peerSelfId`（对端自己的哈希）——对端没发过消息也能
    // 设主人。面板只接触哈希：提交的 senderId 必须是 `snd-` 形状，原始 openid 从不出现。
    // 与主面板共用同一作用域（manifest 里紧跟 97d 拼接），选择动作调用在 97-ui-im.js。

    /** 主人动作的忙碌键判定：与改绑/解绑（`peer:`）分开锁，互不禁用。 */
    function imOwnerBusy(busy) {
      return busy.startsWith('owner:')
    }

    /** 主人展示名：私聊自哈希用「对端」标签，其次昵称，最后回退哈希。 */
    function imOwnerNameOf(peer, owner, t) {
      if (owner === null || owner === undefined) return t('im.owner.none')
      const selfId = typeof peer?.peerSelfId === 'string' ? peer.peerSelfId : ''
      if (selfId !== '' && owner.id === selfId) return t('im.owner.selfName')
      const name = typeof owner.name === 'string' ? owner.name.trim() : ''
      return name !== '' ? name : String(owner.id ?? '')
    }

    /** 选择器选项：最近发言人（已哈希）+ 私聊对端；按 id 去重，对端重标「设为对端为主人」。 */
    function imOwnerOptionsOf(peer, senders, t) {
      const selfId = peer?.scope === 'private' && typeof peer?.peerSelfId === 'string' ? peer.peerSelfId : ''
      const options = []
      const seen = new Set()
      for (const entry of senders ?? []) {
        const id = typeof entry?.id === 'string' ? entry.id : ''
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
        options.push({ id, label: id === selfId ? t('im.owner.setSelf') : (name !== '' ? name : id) })
      }
      if (selfId !== '' && !seen.has(selfId)) options.push({ id: selfId, label: t('im.owner.setSelf') })
      return options
    }

    /** 绑定行里的主人控件：标签由绑定行渲染，这里只给选择器与「取消主人」。 */
    function ImOwnerControls({ peer, owner, senders, disabled, onSetOwner }) {
      const t = useTranslate()
      const options = imOwnerOptionsOf(peer, senders, t)
      const pick = (event) => {
        const value = String(event.target.value ?? '')
        if (value === '') return
        onSetOwner(peer, value)
      }
      return h('div', { className: 'dt-im-peer-actions dt-im-owner', 'data-im-owner': peer.key },
        h('select', {
          value: '',
          disabled: disabled === true,
          'aria-label': t('im.owner.pick'),
          onChange: pick,
        },
          h('option', { value: '' }, t('im.owner.pick')),
          options.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
        owner !== null && owner !== undefined
          ? h(Button, { size: 'sm', variant: 'ghost', disabled: disabled === true, onClick: () => onSetOwner(peer, null) }, t('im.owner.clear'))
          : null)
    }