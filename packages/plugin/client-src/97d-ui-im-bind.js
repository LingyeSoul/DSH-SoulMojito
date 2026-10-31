    // 扫码面板（决策 2026-10-31-im-native-session-binding / 提案 0024 §6.3）：
    // 二维码 / 微信验证码 / 失败原因 + 重试。与主面板共用同一作用域（manifest 里
    // 紧跟 97cc 行为页拼接），扫码相位轮询在 97-ui-im.js 的 PanelIm 里。
    //
    // 二维码的图片来源：平台有时给内容串（要编码），有时直接给图片地址。
    // 图片地址优先透传，其余用服务端渲染好的 `qrSvg`；两者都没有就退回链接。
    function imLooksLikeImageUrl(value) {
      if (value === '') return false
      return /^data:image\//i.test(value) || /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(value)
    }

    function imQrSrc(bind) {
      const url = typeof bind.url === 'string' ? bind.url : ''
      if (imLooksLikeImageUrl(url)) return url
      const qrSvg = typeof bind.qrSvg === 'string' ? bind.qrSvg : ''
      return qrSvg !== '' ? qrSvg : url
    }

    /** 扫码面板：二维码 / 微信验证码 / 失败原因 + 重试。单会话共用。 */
    function ImBindPanel({ bind, qrFailedFor, verifyCode, busy, onQrFailed, onVerifyCode, onSubmit, onRetry, onCancel }) {
      const t = useTranslate()
      const src = imQrSrc(bind)
      const url = typeof bind.url === 'string' ? bind.url : ''
      const phase = bind.phase
      const showQr = phase === 'waiting' || phase === 'saving'
      const hasQr = showQr && src !== ''
      return h('section', { className: 'dt-settings-band dt-im-bind', 'data-im-bind-phase': phase },
        h('div', { className: `dt-im-bind-layout${hasQr ? ' dt-im-bind-layout-with-qr' : ''}` },
          h('div', { className: 'dt-im-bind-copy' },
            h('h3', null, t('im.bindTitle', { channel: t(`im.channel.${bind.channel}`) })),
            phase === 'failed' ? h('p', { className: 'dt-error' }, t('im.bindFailed', { reason: bind.reason || '—' })) : null,
            phase === 'verify'
              ? h('div', { className: 'dt-im-verify' },
                h('label', { className: 'dt-field' },
                  h('span', { className: 'dt-label' }, t('im.bindVerify')),
                  h('input', {
                    type: 'text', inputMode: 'numeric', value: verifyCode,
                    'aria-label': t('im.bindVerify'), onChange: (event) => onVerifyCode(event.target.value),
                  })),
                h(Button, {
                  size: 'sm', variant: 'primary', onClick: onSubmit,
                  disabled: imBindBusy(busy) || verifyCode.trim() === '',
                }, busy === 'verify' ? t('im.bindSubmitting') : t('im.bindVerifySubmit')),
                h('p', { className: 'dt-hint dt-hint-wide' }, bind.prompt || t('im.bindVerifyHint')))
              : null,
            showQr ? h('p', { className: 'dt-hint' }, phase === 'saving' ? t('im.bindSaving') : t('im.bindWaiting')) : null),
          showQr
            ? h('div', { className: 'dt-im-qr' },
              src !== '' && qrFailedFor !== src ? h('img', { src, alt: t('im.bindQrAlt'), onError: () => onQrFailed(src) }) : null,
              src === ''
                ? h('p', { className: 'dt-muted' }, t('im.bindQrPending'))
                : h('a', {
                  className: 'dt-im-qr-link',
                  // 备用链接指向平台给的内容地址：图挂了还能点开它，而不是打开一张 data URL。
                  href: url !== '' ? url : src, target: '_blank', rel: 'noreferrer',
                }, t('im.bindQrLink')))
            : null),
        h('div', { className: 'dt-im-bind-actions' },
          phase === 'failed' ? h(Button, { size: 'sm', variant: 'outline', disabled: imBindBusy(busy), onClick: onRetry }, t('im.bindRetry')) : null,
          h(Button, { size: 'sm', variant: 'ghost', disabled: imBindBusy(busy), onClick: onCancel }, t('im.bindCancel'))))
    }
