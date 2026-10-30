    function installStyle() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-soulmojito'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = `
         [data-dsh-soulmojito-native-hidden],[data-dsh-soulmojito-tab-hidden],[data-dsh-soulmojito-agent-preset-hidden]{display:none!important}
        .dt-settings{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:0;min-height:100%;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-settings-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings h2{font-size:20px;line-height:28px;margin:0;font-weight:600}.dt-settings-heading p{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:4px 0 0}.dt-settings-version{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:2px 0 0;user-select:text}.dt-settings-band{padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings-band h3{font-size:14px;line-height:20px;margin:0 0 14px;font-weight:600}.dt-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}.dt-field{display:flex;flex-direction:column;gap:6px}.dt-label{color:var(--dsw-alias-label-secondary);font-size:12px}.dt-field select{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-toggle,.dt-check-grid label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}.dt-toggle{min-height:36px}.dt-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}.dt-imports{display:flex;gap:8px;flex-wrap:wrap}.dt-upload{position:relative;cursor:pointer;height:34px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:13px}.dt-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}.dt-upload-error{color:var(--dsw-alias-state-error-primary);margin-left:5px}.dt-error,.dt-run-error,.dt-sidebar-error{color:var(--dsw-alias-state-error-primary)}.dt-muted{color:var(--dsw-alias-label-tertiary)}
         .dt-view{box-sizing:border-box;width:100%;max-width:780px;margin:0 auto;display:flex;flex-direction:column;min-height:100%;padding:8px 16px 28px;color:var(--dsw-alias-label-primary);letter-spacing:0}.dt-empty{min-height:300px;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px}.dt-message-actions button,.dt-header-character button,.dt-sidebar button,.dt-footer-action{color:inherit;background:transparent;border:0;cursor:pointer}.dt-message-actions button:hover,.dt-header-character button:hover,.dt-sidebar button:hover,.dt-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-view button:disabled,.dt-composer button:disabled,.dt-sidebar button:disabled{cursor:not-allowed;opacity:.45}.dt-transcript{display:flex;flex-direction:column;gap:22px;padding:22px 4px}.dt-message{display:flex;gap:10px;max-width:88%;min-width:0}.dt-message-user{align-self:flex-end}.dt-message-character{align-self:flex-start}.dt-message-avatar{width:30px;height:30px;object-fit:cover;border-radius:6px;flex:none}.dt-message-body{display:flex;flex-direction:column;gap:4px;min-width:0}.dt-message-user .dt-message-body{align-items:flex-end}.dt-message-name{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-message-copy{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-raised,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2)}.dt-reasoning{display:flex;flex-direction:column;gap:3px;max-width:100%;min-width:0}.dt-reasoning-toggle{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;cursor:pointer;font-size:11px;line-height:16px;padding:2px 4px;border-radius:5px}.dt-reasoning-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-reasoning-toggle svg{transition:transform 120ms ease}.dt-reasoning-toggle.dt-reasoning-open svg{transform:rotate(180deg)}.dt-reasoning-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,var(--dsw-alias-bg-base));max-height:280px;overflow-y:auto}.dt-message-user .dt-message-copy{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-base))}.dt-message-frontend{width:min(760px,82vw);max-width:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}.dt-frontend-frame{display:block;width:100%;border:0;background:transparent;transition:height 180ms ease}.dt-frontend-resizable{display:flex;flex-direction:column;width:100%;min-width:0}.dt-frontend-resizable-dragging .dt-frontend-frame{transition:none}.dt-frontend-resize-handle{display:flex;align-items:center;justify-content:center;height:16px;flex:none;cursor:ns-resize;touch-action:none;user-select:none;-webkit-user-select:none;color:var(--dsw-alias-label-tertiary);outline:none}.dt-frontend-resize-handle:focus-visible{border-radius:4px;box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}.dt-frontend-resize-grip{display:block;width:40px;height:4px;border-radius:2px;background:currentColor;opacity:.35;transition:opacity 120ms ease}.dt-frontend-resize-handle:hover .dt-frontend-resize-grip,.dt-frontend-resize-handle:focus-visible .dt-frontend-resize-grip{opacity:.75}.dt-frontend-resize-handle[data-manual="true"] .dt-frontend-resize-grip{background:var(--dsw-alias-state-business-primary);opacity:.85}.dt-message-actions{display:flex;align-items:center;gap:4px;min-height:24px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dt-message-actions button{min-width:24px;height:24px;border-radius:5px;display:inline-grid;place-items:center;padding:0 5px}.dt-message-edit{box-sizing:border-box;width:min(620px,70vw);max-width:100%;min-height:100px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:9px;font:inherit;line-height:1.55}.dt-transcript-end{height:1px;flex:none}.dt-message-error{max-width:620px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}.dt-run-error{padding:7px 12px;font-size:12px}
         .dt-composer-wrap{box-sizing:border-box;width:100%;padding:6px var(--dsh-composer-side-clearance,16px) 14px;pointer-events:auto}.dt-composer{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px),100%);margin:0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);padding:10px 10px 8px;box-shadow:0 2px 10px rgba(0,0,0,.06)}.dt-composer textarea{box-sizing:border-box;width:100%;min-height:52px;max-height:200px;resize:vertical;border:0;outline:0;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;font-size:14px;line-height:1.5}.dt-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;font-size:11px}.dt-composer-row>span{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-composer-actions{display:flex;align-items:center;gap:8px;flex:none}.dt-primary-icon{width:30px;height:30px;border:0;border-radius:7px;display:grid;place-items:center;background:var(--dsw-alias-state-business-primary);color:#fff;cursor:pointer}.dt-header-character{min-width:0;display:flex;align-items:center;gap:7px;padding:2px 4px 2px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12px}.dt-header-character>img{width:20px;height:20px;border-radius:4px;object-fit:cover;flex:none}.dt-header-character-copy{display:flex;flex-direction:column;min-width:0;max-width:min(520px,55vw);gap:0}.dt-header-character-name{max-width:100%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;line-height:16px}.dt-header-stats{display:block;max-width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dt-header-character>button{width:24px;height:24px;border-radius:5px;display:grid;place-items:center;flex:none}
        .dt-model-select{min-width:0;position:relative}.dt-model-trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}.dt-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dt-model-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.dt-model-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dt-model-trigger-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.dt-model-trigger-effort{color:var(--dsw-alias-label-caption);flex:none}.dt-model-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.dt-model-chevron-open{transform:rotate(180deg)}.dt-model-menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(240px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.dt-model-status,.dt-model-empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.dt-model-error,.dt-model-warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}.dt-model-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}.dt-model-retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}.dt-model-groups{min-height:0;overflow-y:auto}.dt-model-group+.dt-model-group{margin-top:4px}.dt-model-group-title{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.dt-model-option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.dt-model-option:hover:not(:disabled),.dt-model-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.dt-model-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dt-model-option-copy{flex-direction:column;flex:1;min-width:0;display:flex}.dt-model-name{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.dt-model-description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}.dt-model-check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}.dt-model-cell{width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}.dt-model-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-model-cell-label{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.dt-model-cell-value{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:0 auto;overflow:hidden}.dt-model-cell-chevron{color:var(--dsw-alias-label-tertiary);flex:none}
        [data-dsh-soulmojito-sidebar-host]{flex:none;margin:0 0 6px;padding-right:var(--dsh-session-list-edge-inset,8px)}.dt-sidebar{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-sidebar-scroll{display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);overflow-y:auto;overflow-x:hidden}.dt-sidebar-heading{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 5px;color:var(--dsw-alias-label-secondary)}.dt-sidebar-heading>span{display:flex;align-items:center;gap:6px;font-size:12px}.dt-sidebar-heading>button{width:26px;height:26px;border-radius:6px}.dt-character-group{margin-top:2px}.dt-character-row{display:flex;align-items:center;gap:2px}.dt-character-toggle{height:32px;min-width:0;flex:1;display:flex;align-items:center;gap:5px;border-radius:6px;padding:0 5px;text-align:left}.dt-character-toggle svg{transform:rotate(-90deg);transition:transform .15s}.dt-character-toggle svg.dt-chevron-open{transform:rotate(0)}.dt-character-toggle img{width:22px;height:22px;border-radius:5px;object-fit:cover}.dt-character-toggle span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dt-character-row>button:last-child{width:28px;height:28px;display:grid;place-items:center;border-radius:6px;flex:none}.dt-sidebar-chats{display:flex;flex-direction:column;margin:1px 0 4px 28px}.dt-sidebar-chat-row{height:28px;border-radius:6px;display:grid;grid-template-columns:minmax(0,1fr) repeat(3,26px);align-items:center;color:var(--dsw-alias-label-secondary)}.dt-sidebar-chat-open{height:28px;min-width:0;text-align:left;padding:0 7px;color:inherit;font-size:12px}.dt-sidebar-chat-open span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){width:26px;height:26px;display:grid;place-items:center;border-radius:5px;opacity:0}.dt-sidebar-chat-row:hover>button:not(.dt-sidebar-chat-open),.dt-sidebar-chat-row:focus-within>button:not(.dt-sidebar-chat-open){opacity:1}.dt-sidebar-chat-row.dt-sidebar-chat-active{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.dt-sidebar-status,.dt-sidebar-error{padding:4px 7px;font-size:11px;line-height:16px}.dt-footer-action{box-sizing:border-box;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:none;font-family:inherit;display:flex;align-items:center;overflow:hidden}.dt-footer-action-wide{width:calc(100% + 8px);height:34px;flex:none;justify-content:flex-start;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;border-radius:12px;font-size:14px;line-height:22px}.dt-footer-action-wide:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-footer-action-rail{width:36px;height:36px;flex:none;justify-content:center;gap:0;margin:8px 0 10px;padding:0;border-radius:50%}.dt-footer-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px}.dt-sidebar-heading-toggle{min-width:0;flex:1;width:auto;height:26px;display:flex;align-items:center;gap:6px;border-radius:6px;padding:0 5px;text-align:left;font-size:12px}.dt-sidebar-heading>button.dt-sidebar-heading-toggle{width:auto}.dt-sidebar-chevron{display:flex;align-items:center;flex:none}.dt-sidebar-chevron svg{transform:rotate(-90deg);transition:transform .15s}.dt-sidebar-chevron svg.dt-chevron-open{transform:rotate(0)}.dt-sidebar-heading-label{display:flex;align-items:center;gap:6px;min-width:0}.dt-sidebar-heading-label strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
         @media(max-width:700px){[role="dialog"]:has(.dt-settings){flex-direction:column}[role="dialog"]:has(.dt-settings)>nav{box-sizing:border-box;width:100%;height:auto;max-height:190px;flex:none;overflow-y:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}[role="dialog"]:has(.dt-settings)>nav>:last-child{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:auto}[role="dialog"]:has(.dt-settings)>nav>:last-child>button{width:100%;min-width:0}[role="dialog"]:has(.dt-settings)>:not(nav){width:100%;min-width:0;flex:1}.dt-settings-heading{padding:16px}.dt-settings-band{padding:16px}.dt-settings-grid,.dt-check-grid{grid-template-columns:1fr}.dt-view{padding-inline:10px}.dt-transcript-end{height:132px}.dt-message{max-width:94%}.dt-header-character-copy{max-width:min(340px,52vw)}.dt-header-stats{max-width:100%}.dt-composer-wrap{padding-inline:8px}.dt-model-trigger{max-width:140px}.dt-message-edit{width:78vw}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){opacity:1}}
        .dt-persona-list{display:flex;flex-direction:column;gap:6px}.dt-persona-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;transition:background .12s}.dt-persona-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-persona-avatar{width:36px;height:36px;border-radius:7px;object-fit:cover;flex:none}.dt-persona-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}.dt-persona-copy strong{font-size:14px;line-height:20px}.dt-persona-copy span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-persona-actions{display:flex;gap:2px;flex:none}.dt-persona-actions button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}.dt-persona-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-group-create{display:flex;flex-direction:column;gap:8px;margin:10px 0;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}.dt-group-list{display:flex;flex-direction:column;gap:12px}.dt-group-manage{display:flex;flex-direction:column;gap:6px}.dt-group-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dt-group-title>span{color:var(--dsw-alias-label-tertiary);font-size:12px}.dt-group-title select{height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-base);padding:0 6px}.dt-group-title>button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}.dt-group-members{display:flex;flex-wrap:wrap;gap:6px}
        .dt-member-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px 0 3px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:inherit;font-size:12px;cursor:pointer}.dt-member-chip>img{width:22px;height:22px;border-radius:50%;object-fit:cover}.dt-member-chip-off{opacity:.45}.dt-member-chip-off>span{text-decoration:line-through}.dt-member-chip-active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.dt-member-chip>button{color:inherit;background:transparent;border:0;cursor:pointer;padding:0 2px;font-size:11px}
        .dt-band-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}.dt-band-actions>.dt-upload{height:32px;font-size:13px}.dt-band-actions>.dt-upload:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-band-actions>button{min-height:32px;font-size:13px}
        .dt-regex-list{display:flex;flex-direction:column;gap:6px}.dt-regex-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;transition:background .12s}.dt-regex-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-regex-row.dt-regex-off{opacity:.55}.dt-regex-check{min-height:0;flex:none}.dt-regex-main{display:flex;flex-direction:column;gap:1px;min-width:0}.dt-regex-head{display:flex;align-items:baseline;gap:8px;min-width:0}.dt-regex-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}.dt-regex-owner{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-regex-placements{flex:none;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-regex-pattern{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:16px}.dt-regex-actions{display:flex;gap:2px;flex:none}.dt-regex-actions button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}
.dt-regex-actions button.dt-regex-release{width:auto;padding:0 7px;font-size:11px;line-height:16px;white-space:nowrap}.dt-regex-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dt-regex-actions button:disabled{opacity:.4;cursor:not-allowed}.dt-regex-item{display:flex;flex-direction:column;gap:4px}
        /* 正则按来源分区（2026-10-23 用户需求）：段头一行放来源名、当前标记、
           条数与清空按钮；窄屏允许换行，名字独占剩余宽度并省略。 */
        .dt-regex-groups{display:flex;flex-direction:column;gap:14px}.dt-regex-group{display:flex;flex-direction:column;gap:6px}.dt-regex-group-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dt-regex-group-fold{display:flex;align-items:center;gap:6px;flex:1;min-width:0;flex-wrap:wrap;margin:0;padding:2px 4px;border:0;border-radius:6px;color:inherit;background:transparent;cursor:pointer;font:inherit;text-align:left}.dt-regex-group-fold:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-regex-group-fold:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}.dt-regex-group-fold svg{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg);transition:transform .15s}.dt-regex-group-fold svg.dt-chevron-open{transform:rotate(0)}.dt-regex-group-fold-static{cursor:default}.dt-regex-group-fold-static:hover{background:transparent}.dt-regex-group-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}.dt-regex-group-active{padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:16px}.dt-regex-group-inactive{padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 14%,transparent);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-regex-group-count{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-regex-group-delete{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-tertiary);background:transparent;font-size:11px;line-height:16px;cursor:pointer}.dt-regex-group-delete:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}.dt-regex-group-delete:disabled{opacity:.4;cursor:not-allowed}.dt-regex-group-toggle{min-height:0;gap:0}.dt-regex-group-toggle input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}.dt-regex-group-toggle input:disabled{cursor:not-allowed;opacity:.4}
        .dt-field input[type=text],.dt-field input[type=password]{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-upload:disabled{opacity:.5;cursor:not-allowed}
        .dt-backlink{display:flex;padding:2px 0}.dt-backlink>button{color:var(--dsw-alias-label-tertiary);background:transparent;border:0;cursor:pointer;font-size:12px;padding:4px 2px}.dt-backlink>button:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
        .dt-member-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.dt-member-row .dt-member-chip>button{display:none}.dt-script-glyph{font-weight:700;font-size:15px;line-height:1}.dt-sidebar-subheading{margin-top:10px}.dt-branch-btn{font-size:13px}
        .dt-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0 0 12px}.dt-hint-wide{grid-column:1 / -1;margin:0 0 12px}
        .dt-frontend-resources{margin-top:10px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}.dt-frontend-resources .dt-toggle{min-height:0}.dt-frontend-warning{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warning-primary));margin:6px 0 0}
        /* 行为设置分组（2026-10-21 开关收编）：每组上边框分隔 + 12px 组标题的
           分隔语汇；组内开关去掉 36px 最小高，紧凑平铺。 */
        .dt-behavior-group{display:flex;flex-direction:column;gap:6px;margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-behavior-group h4{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
        .dt-behavior-group .dt-toggle{min-height:0}
        .dt-prompts-intro{max-width:760px;margin:0 0 14px;padding:12px 14px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}.dt-prompts-intro h3{margin:0 0 4px;font-size:13px;line-height:19px;font-weight:600}.dt-prompts-desc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:19px}
        .dt-prompts-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}.dt-prompts-toolbar>button{min-height:32px}.dt-prompts-filter{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dt-prompts-filter select{box-sizing:border-box;height:32px;min-width:180px;max-width:280px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 8px;font:inherit;font-size:13px}
        .dt-panel-empty{display:flex;align-items:center;justify-content:center;min-height:88px;padding:18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:12px;line-height:18px}.dt-panel-empty p{margin:0}
        .dt-prompt-records{display:flex;flex-direction:column;gap:8px}.dt-prompt-record{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font-size:12px}.dt-prompt-record>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-prompt-record[open]>summary{margin-bottom:8px;color:var(--dsw-alias-label-primary);white-space:normal}.dt-prompt-record>.dt-label{margin:8px 0 4px}.dt-prompt-record>.dt-hint{margin:4px 0}.dt-prompt-message{margin:0 0 8px}.dt-prompt-message-head{display:flex;align-items:center;gap:2px;min-height:20px}.dt-prompt-pre{margin:2px 0 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.dt-prompt-system>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:2px 0 4px}.dt-prompt-lore{margin:8px 0;overflow-x:auto}.dt-prompt-lore table{width:100%;border-collapse:collapse;font-size:12px}.dt-prompt-lore th,.dt-prompt-lore td{border:1px solid var(--dsw-alias-border-l2);padding:3px 6px;text-align:left;vertical-align:top}.dt-prompt-lore th{color:var(--dsw-alias-label-secondary);font-weight:600;white-space:nowrap}
        .dt-settings-update{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
        .dt-update-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
        .dt-update-stamp{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;user-select:text}
        .dt-update-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:1;font-weight:600;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
        .dt-update-badge-available{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
        .dt-update-badge-pending{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary));border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}
        .dt-update-badge-current{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
        .dt-update-badge-unknown{opacity:.75}
        .dt-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 12px}
        .dt-update-notes{margin:0 0 12px}
        .dt-update-notes-title{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
        .dt-update-notes ul{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-update-log{margin:0 0 12px;padding:8px 10px;max-height:132px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-tertiary);font-family:monospace;font-size:11px;line-height:16px;white-space:pre-wrap}
        .dt-panel-modal{pointer-events:auto;width:min(1080px,calc(100vw - 48px));height:min(700px,calc(100vh - 64px));max-width:100%;max-height:100%;padding:0;gap:0;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
        .dt-panel{display:flex;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0;background:var(--dsw-alias-bg-base);border-radius:12px;overflow:hidden}
        .dt-panel-nav{display:flex;flex-direction:column;gap:2px;width:198px;flex:none;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow:hidden}
        .dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}
        .dt-panel-brand{display:flex;align-items:center;gap:9px;padding:4px 8px 12px;color:var(--dsw-alias-label-primary)}
        .dt-panel-brand>svg{color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));flex:none}
        .dt-panel-brand-copy{display:flex;flex-direction:column;min-width:0}
        .dt-panel-brand-copy strong{font-size:14px;line-height:18px}
        .dt-panel-brand-copy span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;user-select:text}
        .dt-panel-navcell{display:flex;align-items:center;gap:9px;min-height:34px;padding:0 9px;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:13px;line-height:18px;text-align:left}
        .dt-panel-navcell>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-panel-navcell:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-panel-navcell-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
        .dt-panel-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
        .dt-panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dt-panel-header h2{margin:0;font-size:16px;line-height:22px;font-weight:600}
        .dt-panel-close{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
        .dt-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-panel-body{flex:1;min-height:0;overflow-y:auto}
        .dt-panel-body .dt-sidebar{padding:0 4px}
        .dt-panel-search{box-sizing:border-box;width:100%;height:30px;margin:0 0 8px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;font-size:12px;flex:none}
        .dt-panel-search::placeholder{color:var(--dsw-alias-label-tertiary)}
        .dt-panel-search:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 25%,transparent)}
        .dt-panel-group{display:flex;flex-direction:column;gap:2px;margin-top:6px}
        .dt-panel-group:first-of-type{margin-top:2px}
        .dt-panel-group-label{padding:6px 9px 2px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:11px;line-height:15px;font-weight:600;user-select:none}
        .dt-panel-search-empty{margin:8px 9px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-panel-navcell:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary)}
        .dt-panel-header-actions{display:flex;align-items:center;gap:4px;flex:none}
        .dt-panel-expand{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
        .dt-panel-expand:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-panel-modal-full{width:calc(100vw - 24px)!important;height:calc(100vh - 24px)!important}
        .dt-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:8px;margin:0 0 4px}
        .dt-stat{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:inherit;cursor:pointer;text-align:left;transition:background .12s,border-color .12s}
        .dt-stat:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
        .dt-stat:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
        .dt-stat-value{font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums}
        .dt-stat-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
        .dt-filter-row{display:flex;max-width:340px;margin:0 0 12px}
        .dt-about-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
        .dt-about-head>svg{flex:none}
        .dt-about-head-copy{display:flex;flex-direction:column;min-width:0}
        .dt-about-head-copy h3{margin:0}
        .dt-about-links{display:flex;flex-direction:column;gap:10px;margin-top:4px}
        .dt-about-row{display:flex;align-items:baseline;gap:10px;min-width:0;flex-wrap:wrap}
        .dt-about-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-width:96px;flex:none}
        .dt-about-row a{color:var(--dsw-alias-state-business-primary);font-size:13px;line-height:18px;text-decoration:none;overflow-wrap:anywhere}
        .dt-about-row a:hover,.dt-about-row a:focus-visible{text-decoration:underline}
        .dt-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
        .dt-card{display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-card-head{display:flex;align-items:center;gap:9px}
        .dt-card-head>img{width:40px;height:40px;border-radius:8px;object-fit:cover;flex:none}
        .dt-card-title{display:flex;flex-direction:column;min-width:0;flex:1}
        .dt-card-title strong{font-size:14px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-card-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-card-fields{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}
        .dt-card-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:28px;border:0;padding:0 2px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:12px;text-align:left}
        .dt-card-field-head:hover{color:var(--dsw-alias-label-primary)}
        .dt-card-field-head svg{transform:rotate(-90deg);transition:transform .15s}
        .dt-card-field-head .dt-chevron-open{transform:rotate(0)}
        .dt-card-copy{max-height:220px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;padding:2px 2px 8px;border-radius:6px}
        .dt-world-list{display:flex;flex-direction:column;gap:6px}
        .dt-world-row{display:flex;align-items:center;gap:8px;min-height:36px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
        .dt-world-follow{flex:none;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dt-world-follow-off{opacity:.6;text-decoration:line-through}
        .dt-world-row>.dt-toggle{flex:1;min-width:0}
        .dt-entry-list{display:flex;flex-direction:column;gap:6px}
        .dt-entry{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:13px}
        .dt-entry-off{opacity:.55}
        .dt-entry-head{display:flex;flex-direction:column;gap:1px}
        .dt-entry-keys{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-entry-content{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:160px;overflow-y:auto}
        .dt-preset-list{display:flex;flex-direction:column;gap:6px}
        .dt-preset-row{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-wrap:wrap}
        .dt-preset-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
        .dt-editor{display:flex;flex-direction:column;gap:12px;min-width:0}
        .dt-editor-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;flex-wrap:wrap}
        .dt-editor-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-editor-actions{display:flex;align-items:center;gap:6px}
        .dt-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .dt-editor-field{display:flex;flex-direction:column;gap:5px;min-width:0}
        .dt-editor-field input,.dt-editor-field textarea,.dt-editor-field select{box-sizing:border-box;width:100%;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:7px 9px;font:inherit;font-size:13px;line-height:18px;outline:none}
        .dt-editor-field input:focus,.dt-editor-field textarea:focus,.dt-editor-field select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
        .dt-editor-field textarea{min-height:108px;resize:vertical;white-space:pre-wrap}
        .dt-editor-field.dt-editor-json textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
        .dt-editor-wide{grid-column:1 / -1}
        .dt-editor-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
        .dt-editor-entries{display:flex;flex-direction:column;gap:10px}
        .dt-editor-entry{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
        .dt-editor-entry-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}
        .dt-editor-toggles{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-top:3px}
        .dt-editor-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
        .dt-editor-toggle input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
        .dt-kv-list{display:flex;flex-direction:column;gap:6px;max-width:640px}
        .dt-kv-row{display:grid;grid-template-columns:minmax(110px,200px) 1fr 28px;gap:8px;align-items:center}
        .dt-kv-readonly>span{font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-kv-key{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
        .dt-kv-value{color:var(--dsw-alias-label-primary)}
        .dt-segmented{display:inline-flex;align-items:stretch;align-self:flex-start;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;overflow:hidden}
        .dt-segmented button{min-height:32px;padding:0 12px;border:0;border-right:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);cursor:pointer;font:inherit;font-size:12px}
        .dt-segmented button:last-child{border-right:0}
        .dt-segmented button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-segmented button:disabled{cursor:not-allowed;opacity:.45}
        .dt-segmented .dt-segmented-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
        .dt-architecture-badge{display:inline-flex;align-items:center;align-self:flex-start;min-height:18px;padding:0 6px;border-radius:4px;font-size:10px;line-height:18px;font-weight:600;white-space:nowrap}
        .dt-architecture-agent-tavern{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .dt-architecture-st{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-sidebar-chat-open{display:flex;align-items:center;gap:6px}
        .dt-sidebar-chat-open>span:first-child{min-width:0;flex:1}
        .dt-chat-architecture{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;white-space:nowrap}
        .dt-audit{display:flex;flex-direction:column;gap:8px}
        .dt-audit-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-audit h4{margin:10px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
        .dt-audit-list{display:flex;flex-direction:column;gap:6px}
        .dt-audit-row{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
        .dt-audit-row-inactive{opacity:.65}
        .dt-audit-row-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
        .dt-audit-row-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
        .dt-audit-row p{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-audit-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}
        .dt-audit-row pre{margin:0;max-height:120px;overflow:auto;color:var(--dsw-alias-label-primary);font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-tc-state{display:inline-flex;align-items:center;padding:0 4px}
        .dt-header-character{padding:0;border:0;border-radius:0}
        @media(max-width:700px){.dt-panel{flex-direction:column}.dt-panel-nav{box-sizing:border-box;width:100%;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-panel-navlist{display:contents}.dt-panel-group{display:contents}.dt-panel-brand{padding:4px 8px}.dt-panel-brand-copy{display:none}.dt-panel-navcell{flex:none}.dt-card-grid{grid-template-columns:1fr}.dt-kv-row{grid-template-columns:1fr 1fr 28px}.dt-editor-grid{grid-template-columns:1fr}.dt-editor-wide{grid-column:auto}.dt-editor-toolbar{align-items:flex-start}.dt-preset-row{align-items:flex-start}.dt-preset-name{flex-basis:100%}.dt-panel-search{display:none}.dt-panel-group-label{display:none}}
        .dt-novel-badge{display:inline-flex;align-items:center;min-height:18px;padding:0 7px;border-radius:9px;font-size:10px;line-height:18px;font-weight:600;white-space:nowrap}
        .dt-novel-badge-active{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .dt-novel-badge-paused{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));background:var(--dsw-alias-interactive-bg-hover)}
        .dt-novel-badge-completed{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-novel-list{display:flex;flex-direction:column;gap:10px}
        .dt-novel-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-novel-card .dt-error,.dt-novel-detail .dt-error{margin:0}
        .dt-novel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-novel-title{min-width:0;flex:1;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;font-weight:600;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-novel-title:hover{color:var(--dsw-alias-state-business-primary)}
        .dt-novel-title-text{font-size:14px;line-height:20px;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-novel-reason{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}
        .dt-novel-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-novel-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-novel-detail{display:grid;grid-template-columns:210px minmax(0,1fr) 250px;gap:14px;align-items:start}
        .dt-novel-col{display:flex;flex-direction:column;gap:12px;min-width:0}
        .dt-novel-block{display:flex;flex-direction:column;gap:6px;min-width:0}
        .dt-novel-block h4{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-novel-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
        .dt-novel-import-preview{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
        .dt-novel-toc{display:flex;flex-direction:column;gap:2px}
        .dt-novel-chapter{display:flex;flex-direction:column;gap:1px;align-items:flex-start;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:5px 6px;border-radius:6px}
        .dt-novel-chapter:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-novel-chapter-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
        .dt-novel-chapter-title{font-size:13px;line-height:18px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-novel-chapter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
        .dt-novel-paragraphs{display:flex;flex-direction:column;gap:12px}
        .dt-novel-paragraph{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary)}
        .dt-novel-reqs{display:flex;flex-direction:column;gap:6px}
        .dt-novel-req{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px}
        .dt-novel-req-head{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;line-height:16px}
        .dt-novel-req-status{font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-novel-req-blocked .dt-novel-req-status{color:var(--dsw-alias-state-error-primary)}
        .dt-novel-req-text{margin:0;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
        .dt-novel-req-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}
        .dt-novel-kv{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
        .dt-novel-kv span{overflow-wrap:anywhere}
        .dt-novel-fores{display:flex;flex-direction:column;gap:4px}
        .dt-novel-fore{display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:17px}
        .dt-novel-fore-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
        .dt-novel-outline-pre{margin:0;max-height:60vh;overflow:auto;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
        .dt-novel-approve{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
        .dt-novel-approve input{box-sizing:border-box;width:130px;min-height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:5px 8px;font:inherit;font-size:12px}
        .dt-novel-modal{pointer-events:auto;display:flex;flex-direction:column;width:min(760px,calc(100vw - 48px));height:min(680px,calc(100vh - 64px));max-width:100%;max-height:100%;padding:0;gap:0;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
        .dt-editor-modal{pointer-events:auto;display:flex;flex-direction:column;width:min(900px,calc(100vw - 48px));height:min(780px,calc(100vh - 64px));max-width:100%;max-height:100%;padding:0;gap:0;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
        .dt-editor-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dt-editor-modal-head h2{margin:0;font-size:16px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-editor-modal-body{flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
        .dt-editor-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
        .dt-persona-editor{width:min(640px,calc(100vw - 48px));height:auto;max-height:min(720px,calc(100vh - 64px))}
        .dt-persona-editor .dt-editor-modal-body{flex:0 1 auto;min-height:0;overflow-y:auto}
        @media(max-width:700px){.dt-editor-modal{width:calc(100vw - 24px);height:calc(100vh - 24px)}.dt-editor-modal-body{padding:12px}.dt-persona-editor{height:auto;max-height:calc(100vh - 24px)}}
        .dt-novel-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dt-novel-modal-head h2{margin:0;font-size:16px;line-height:22px;font-weight:600}
        .dt-novel-modal-body{flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
        .dt-novel-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-greeting-modal{pointer-events:auto;width:min(620px,calc(100vw - 32px));max-height:min(680px,calc(100vh - 64px));background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l1)}
        .dt-greeting-hint{margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-greeting-list{display:flex;flex-direction:column;gap:8px;max-height:min(60vh,520px);overflow-y:auto;padding:2px}
        .dt-greeting-option{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;font:inherit;padding:10px 12px}
        .dt-greeting-option:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}
        .dt-greeting-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:600}
        .dt-greeting-preview{font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-assistant-images{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0}
        .dt-assistant-images-end{justify-content:flex-end}
        .dt-assistant-images img{max-width:min(320px,100%);max-height:320px;border-radius:8px;object-fit:contain}
        .dt-assistant-fallback{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-novel-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .dt-novel-form-wide{grid-column:1 / -1}
        .dt-novel-form-section{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-novel-form-section h4{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-header-novel-actions{display:flex;align-items:center;gap:2px}
        .dt-header-novel-actions button{min-width:24px;height:24px;padding:0 6px;border:0;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;gap:3px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-header-novel-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        @media(max-width:900px){.dt-novel-detail{grid-template-columns:1fr}}
        @media(max-width:700px){.dt-novel-form-grid{grid-template-columns:1fr}.dt-novel-form-wide{grid-column:auto}}
        .dt-header-actions{display:flex;align-items:center;gap:2px;flex:none}
        .dt-header-actions>button,.dt-rewrite>button,.dt-mvu-slot>button{width:24px;height:24px;border-radius:5px;display:grid;place-items:center;flex:none;color:inherit;background:transparent;border:0;cursor:pointer;padding:0}
        .dt-header-actions>button:hover,.dt-rewrite>button:hover,.dt-mvu-slot>button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-header-actions>button:disabled,.dt-rewrite>button:disabled,.dt-mvu-slot>button:disabled,.dt-rewrite-actions>button:disabled,.dt-candidates button:disabled{cursor:not-allowed;opacity:.45}
        .dt-rewrite{position:relative;display:inline-flex}
        .dt-rewrite-pop{z-index:20;position:absolute;top:calc(100% + 8px);right:0;width:min(320px,calc(100vw - 32px));display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
        .dt-mvu-slot{position:relative;display:inline-flex}
        .dt-mvu-pop{z-index:20;position:absolute;top:calc(100% + 8px);right:0;width:min(360px,calc(100vw - 32px));max-height:min(60vh,540px);overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
        .dt-rewrite-pop textarea{box-sizing:border-box;width:100%;min-height:72px;max-height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:7px 9px;font:inherit;font-size:13px;line-height:18px;outline:none}
        .dt-rewrite-pop textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
        .dt-rewrite-actions{display:flex;justify-content:flex-end;gap:8px}
        .dt-rewrite-actions>button{min-height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:12px}
        .dt-rewrite-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-rewrite-actions>.dt-rewrite-go{color:#fff;background:var(--dsw-alias-state-business-primary);border-color:transparent}
        .dt-swipe-feedback{display:inline-flex;align-items:center;min-height:18px;padding:0 6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;line-height:18px;font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-guide-list{display:flex;flex-direction:column;gap:6px;max-width:640px}
        .dt-guide-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 8px 8px 10px}
        .dt-guide-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
        .dt-guide-add{display:flex;gap:8px;align-items:center;max-width:640px;margin-top:8px;flex-wrap:wrap}
        .dt-guide-add-field{flex:1;min-width:220px}
        .dt-candidates{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px),100%);margin:0 auto 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}
        .dt-candidates-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:4px 8px 4px 6px}
        .dt-candidates-toggle{display:flex;align-items:center;gap:6px;min-width:0;border:0;border-radius:6px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px;padding:3px 6px}
        .dt-candidates-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-candidates-toggle svg{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s}
        .dt-candidates-toggle svg.dt-chevron-open{transform:rotate(180deg)}
        .dt-candidates-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-candidates-actions>button{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-candidates-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-candidates-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}
        .dt-candidates-body p{margin:0}
        .dt-candidates-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
        .dt-candidate-list{display:flex;flex-direction:column;gap:4px}
        .dt-candidate-item{display:flex;align-items:flex-start;gap:8px;width:100%;min-height:30px;text-align:left;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px;line-height:17px;padding:6px 8px}
        .dt-candidate-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
        .dt-candidate-kind{flex:none;display:inline-flex;align-items:center;min-height:16px;padding:0 5px;border-radius:4px;font-size:10px;line-height:16px;font-weight:600;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
        .dt-candidate-kind-scene{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .dt-candidate-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-candidates-feedback{display:flex;gap:6px;align-items:center}
        .dt-candidates-feedback input{box-sizing:border-box;flex:1;min-width:0;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 8px;font:inherit;font-size:12px;outline:none}
        .dt-candidates-feedback input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
        .dt-candidates-feedback>button{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-candidates-feedback>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-mvu{box-sizing:border-box;width:100%;margin:0 auto 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}
        .dt-mvu button:disabled,.dt-script-bound-chip>button:disabled{cursor:not-allowed;opacity:.45}
        .dt-mvu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:4px 8px 4px 6px}
        .dt-mvu-toggle{display:flex;align-items:center;gap:6px;min-width:0;border:0;border-radius:6px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px;padding:3px 6px}
        .dt-mvu-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-mvu-toggle svg{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s}
        .dt-mvu-toggle svg.dt-chevron-open{transform:rotate(180deg)}
        .dt-mvu-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-mvu-actions>button{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-mvu-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-mvu-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}
        .dt-mvu-body p{margin:0}
        .dt-mvu-section-title{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-mvu-vars{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px}
        .dt-mvu-var{display:grid;grid-template-columns:minmax(90px,max-content) minmax(0,1fr);gap:2px 12px;min-width:0}
        .dt-mvu-var-path{font-family:monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
        .dt-mvu-var-value{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
        .dt-mvu-rendered{width:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}
        .dt-mvu-receipts{display:flex;flex-direction:column;gap:4px}
        .dt-mvu-receipt{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px}
        .dt-mvu-receipt-head{display:flex;align-items:center;gap:8px;min-width:0}
        .dt-mvu-badge{flex:none;display:inline-flex;align-items:center;min-height:16px;padding:0 6px;border-radius:4px;font-size:10px;line-height:16px;font-weight:600}
        .dt-mvu-badge-updated{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 12%,transparent)}
        .dt-mvu-badge-unchanged{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-mvu-badge-failed{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
        .dt-mvu-badge-undone{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-mvu-receipt-undone{opacity:.55}
        .dt-mvu-receipt-undone .dt-mvu-change{text-decoration:line-through;text-decoration-color:color-mix(in srgb,currentColor 45%,transparent)}
        .dt-mvu-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-mvu-change{font-family:monospace;font-size:11px;line-height:16px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
        .dt-mvu-more{align-self:flex-start;border:0;padding:0;color:var(--dsw-alias-state-business-primary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-mvu-more:hover{text-decoration:underline}
        .dt-prompt-toggle{border:0;padding:0 0 0 6px;color:var(--dsw-alias-state-business-primary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-prompt-toggle:hover{text-decoration:underline}
        .dt-mvu-failures{display:flex;flex-direction:column;gap:2px}
        .dt-mvu-failures-title{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}
        .dt-mvu-failure{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
        .dt-mvu-side{box-sizing:border-box;width:100%;height:100%;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:14px;padding:14px 14px 24px;color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}
        .dt-mvu-side-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;flex:none}
        .dt-mvu-summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-mvu-side-retry{flex:none;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:12px}
        .dt-mvu-side-actions{flex:none;display:flex;align-items:center;gap:6px}
        .dt-mvu-side-retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-mvu-side-retry:disabled{cursor:not-allowed;opacity:.45}
        .dt-mvu-side-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:220px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px;line-height:20px}
        .dt-mvu-side-empty svg{color:var(--dsw-alias-label-caption)}
        .dt-mvu-side-section{display:flex;flex-direction:column;gap:8px;min-width:0}
        .dt-mvu-side-h{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
        .dt-mvu-side-h>span:first-child{flex:none}
        .dt-mvu-side-h::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l2)}
        .dt-mvu-side-count{flex:none;display:inline-flex;align-items:center;min-height:16px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;font-weight:500;letter-spacing:0}
        .dt-mvu-groups{display:flex;flex-direction:column;gap:10px}
        .dt-mvu-group{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
        .dt-mvu-group-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
        .dt-mvu-group-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;font-weight:600}
        .dt-mvu-group-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}
        .dt-mvu-group-body{display:flex;flex-direction:column}
        .dt-mvu-var-row{display:grid;grid-template-columns:minmax(72px,max-content) minmax(0,1fr);gap:2px 12px;padding:5px 10px}
        .dt-mvu-var-row+.dt-mvu-var-row{border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent)}
        .dt-mvu-side .dt-mvu-var-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
        .dt-mvu-side .dt-mvu-var-value{color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;white-space:pre-wrap}
        .dt-mvu-side .dt-mvu-receipt{gap:4px;border-radius:9px;padding:7px 10px}
        .dt-mvu-side .dt-mvu-change{font-size:11.5px;line-height:17px}
        .dt-mvu-side .dt-mvu-rendered{border-radius:10px}
        .dt-script-card{box-sizing:border-box;width:100%;margin:0 auto 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
        .dt-script-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
        .dt-script-card-title{font-weight:600}
        .dt-script-card-pos{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}
        .dt-script-bar{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
        .dt-script-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
        .dt-script-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
        .dt-script-card-meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
        .dt-script-card-meta .dt-script-name{color:var(--dsw-alias-label-secondary)}
        .dt-script-preview{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:132px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base))}
        .dt-script-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-script-list{display:flex;flex-direction:column;gap:10px}
        .dt-script-row{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}
        .dt-script-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
        .dt-script-name{min-width:0;overflow-wrap:anywhere}
        .dt-script-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-script-bind{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-script-bind select{height:30px;min-width:200px;max-width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-base);padding:0 6px}
        .dt-script-bound{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-script-bound-chip{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 4px 0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
        .dt-script-bound-chip>button{width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:50%;color:inherit;background:transparent;cursor:pointer;font-size:12px;line-height:1}
        .dt-script-bound-chip>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-script-paste{display:flex;flex-direction:column;gap:8px;margin-top:10px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
        .dt-workbench-list{display:flex;flex-direction:column;gap:10px}
        .dt-workbench-plan{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}
        .dt-workbench-plan.dt-workbench-done{opacity:.75}
        .dt-create-choices{display:flex;flex-direction:column;gap:12px}
        .dt-create-choice{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-create-choice-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
        .dt-create-choice-copy h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
        .dt-create-choice-copy .dt-hint{margin:0}
        .dt-create-choice>button{flex:none}
        .dt-workbench-plan-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-workbench-plan-title{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}
        .dt-workbench-plan-title:hover{color:var(--dsw-alias-label-primary)}
        .dt-workbench-plan-title>span:last-child{min-width:0;overflow-wrap:anywhere;font-weight:600}
        .dt-workbench-caret{flex:none;color:var(--dsw-alias-label-tertiary)}
        .dt-workbench-status{flex:none;font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-secondary)}
        .dt-workbench-status-applied{color:var(--dsw-alias-state-business-primary,inherit)}
        .dt-workbench-actions{display:inline-flex;gap:6px;margin-left:auto}
        .dt-workbench-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-workbench-diff{display:flex;flex-direction:column;gap:8px}
        .dt-workbench-entry{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px}
        .dt-workbench-entry-head{display:flex;align-items:center;gap:8px}
        .dt-workbench-entry-uid{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
        .dt-workbench-entry-action{font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-secondary)}
        .dt-workbench-entry-action-remove{color:var(--dsw-alias-state-danger,inherit)}
        .dt-workbench-change{display:flex;flex-direction:column;gap:4px}
        .dt-workbench-change-field{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-workbench-change-values{display:flex;flex-direction:column;gap:4px}
        .dt-workbench-label{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-workbench-old,.dt-workbench-new{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px;max-height:160px;overflow-y:auto;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base))}
        .dt-workbench-old{color:var(--dsw-alias-label-secondary)}
        .dt-workbench-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-mod-list{display:flex;flex-direction:column;gap:10px}
        .dt-mod-row{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}
        .dt-mod-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-mod-row-head>strong{min-width:0;overflow-wrap:anywhere}
        .dt-mod-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-mod-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
        .dt-mod-cap{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px}
        .dt-mod-cap-label{color:var(--dsw-alias-label-tertiary)}
        .dt-mod-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-mod-actions>.dt-mod-meta{margin-right:auto}
        .dt-mod-confirm{display:flex;flex-direction:column;gap:12px;max-width:420px}
        .dt-mod-install{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-mod-install>input[type=text]{flex:1;min-width:220px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:6px 9px;font:inherit;font-size:12px}
        .dt-mod-surface{border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
        .dt-game-row-broken{opacity:.55}
        .dt-game-actions{display:flex;justify-content:flex-end;margin-top:6px}
        .dt-game-resign-armed{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
        .dt-game-board-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
        .dt-game-board-empty>strong{font-size:13px}
        .dt-game-board-empty>p{margin:0;max-width:300px}
        .dt-game-board-empty-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-tertiary)}
        .dt-mod-button-strip{display:flex;flex-direction:column;gap:4px;margin:0 0 6px}
        .dt-mod-button-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-mod-button-owner{color:var(--dsw-alias-label-tertiary);font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-mod-button{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;padding:2px 10px;cursor:pointer}
        .dt-mod-button:hover:not(:disabled){border-color:var(--dsw-alias-border-hi,var(--dsw-alias-border-l2))}
        .dt-mod-button:disabled{opacity:.5;cursor:default}
        .dt-mod-button-error{color:var(--dsw-alias-status-danger,#c0392b);font-size:11px;overflow-wrap:anywhere}
        .dt-mod-log{margin-top:6px}
        .dt-mod-log-toggle{border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer;padding:2px 0}
        .dt-mod-log-toggle:hover{color:var(--dsw-alias-label-secondary)}
        .dt-mod-log-body{margin-top:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base));max-height:220px;overflow-y:auto;padding:6px 8px;display:flex;flex-direction:column;gap:2px}
        .dt-mod-log-line{display:flex;gap:8px;font-size:11px;line-height:1.5;align-items:baseline}
        .dt-mod-log-time{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
        .dt-mod-log-level{flex:none;text-transform:uppercase;font-size:10px;letter-spacing:.04em}
        .dt-mod-log-text{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
        .dt-mod-log-log .dt-mod-log-level{color:var(--dsw-alias-label-tertiary)}
        .dt-mod-log-warn .dt-mod-log-level{color:var(--dsw-alias-status-warning,#b8860b)}
        .dt-mod-log-error .dt-mod-log-level{color:var(--dsw-alias-status-danger,#c0392b)}
        .dt-mod-log-error .dt-mod-log-text{color:var(--dsw-alias-status-danger,#c0392b)}
        .dt-frontend-side{box-sizing:border-box;width:100%;height:100%;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;padding:14px 14px 24px;color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}
        .dt-frontend-side-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;flex:none}
        .dt-frontend-side-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-frontend-side-refresh{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
        .dt-frontend-side-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-frontend-side-refresh:disabled{cursor:default;opacity:.5}
        .dt-frontend-side-refresh[data-busy="true"] svg{animation:dt-frontend-spin .8s linear infinite}
        .dt-frontend-side-actions{display:flex;align-items:center;gap:6px;flex:none}
        .dt-frontend-side-expanded{position:fixed;inset:12px;z-index:80;width:auto;height:auto;max-height:none;padding:14px 16px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3)}
        @keyframes dt-frontend-spin{to{transform:rotate(360deg)}}
        .dt-frontend-side-frames{display:flex;flex-direction:column;gap:12px;min-width:0}
        .dt-frontend-side-frame{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base)}
        .dt-frontend-side-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:220px;padding:16px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px;line-height:20px}
        .dt-frontend-side-empty>p{margin:0;max-width:300px}
        .dt-frontend-side-empty svg{color:var(--dsw-alias-label-caption)}
        .dt-card-scripts-warning{margin:0;padding:9px 11px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-status-warning,#e0af68) 14%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}
        .dt-card-scripts-list{display:flex;flex-direction:column;gap:8px;min-width:0}
        .dt-card-script{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px 11px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
        .dt-card-script-head{display:flex;align-items:baseline;gap:8px;min-width:0}
        .dt-card-script-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}
        .dt-card-script-meta{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-card-script-running{flex:none;color:var(--dsw-alias-status-success,#9ece6a);font-size:11px;line-height:16px}
        .dt-card-script-run{align-self:flex-start;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
        .dt-card-script-run:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-card-script-run:disabled{cursor:not-allowed;opacity:.5}
        .dt-card-script-buttons{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
        .dt-card-scripts-auto{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;padding:8px 11px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-status-success,#9ece6a) 12%,transparent)}
        .dt-card-script-stop{border-color:var(--dsw-alias-status-danger,#f7768e);color:var(--dsw-alias-status-danger,#f7768e)}
        .dt-card-scripts-world{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
        .dt-card-scripts-resets{display:flex;flex-direction:column;gap:8px;min-width:0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-card-script-reset{flex:none;padding:5px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
        .dt-card-script-reset:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-card-script-reset:disabled{cursor:not-allowed;opacity:.5}
        .dt-card-scripts-notice{margin:0;padding:8px 11px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-status-success,#9ece6a) 14%,transparent);font-size:12px;line-height:18px}
        /* ── 图纸视觉层（2026-10-23 深度美化）：宿主 token 之上叠加工程图纸语汇——
           1px 发丝线、等宽数字纪律、150ms 功能动效。全部经既有 token 推导，深/浅
           主题自适应；布局锁定行保持原样，新规则一律后置叠加，移动端断点另起
           独立行，不触碰 700px 契约行。 */
        .dt-panel-modal{border-radius:14px;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(0,0,0,.28))}
        .dt-panel{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary) 2%,var(--dsw-alias-bg-base)),var(--dsw-alias-bg-base) 240px)}
        .dt-panel ::selection{background:var(--dsw-alias-state-business-primary);color:#fff}
        .dt-panel-body,.dt-panel-navlist{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
        /* 品牌块：绿玻璃徽标落座瓷釉瓦片（色号取自 logo 自身调色板，双主题通用）。 */
        .dt-panel-brand-mark{display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:9px;background:color-mix(in srgb,#2f9e77 10%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,#2f9e77 26%,transparent)}
        .dt-panel-brand-copy strong{letter-spacing:.01em}
        .dt-panel-brand-version{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;user-select:text}
        .dt-panel-search{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
        /* 分组：眉题字距 + 发丝线分栏（中文无大小写形态，字距呈现眉题感）。 */
        .dt-panel-group{margin-top:10px;padding-top:8px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent)}
        .dt-panel-group:first-of-type{margin-top:8px;padding-top:0;border-top:0}
        .dt-panel-group-label{padding:2px 9px 6px;font-size:10px;line-height:14px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
        /* 分区格：左侧 3px 荧光签条 + 尾部图纸序号（悬停显影），150ms 功能动效。 */
        .dt-panel-navcell{position:relative;gap:8px;min-height:36px;padding:0 9px;border-radius:8px;transition:background .15s ease,color .15s ease}
        .dt-panel-navcell>svg{flex:none;opacity:.85}
        .dt-panel-navcell-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-panel-navcell-index{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));opacity:0;transition:opacity .15s ease}
        .dt-panel-navcell:hover .dt-panel-navcell-index,.dt-panel-navcell-active .dt-panel-navcell-index{opacity:.7}
        .dt-panel-navcell::before{content:"";position:absolute;left:-8px;top:50%;width:3px;height:18px;border-radius:2px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));transform:translateY(-50%) scaleY(0);transition:transform .18s cubic-bezier(.2,.8,.2,1)}
        .dt-panel-navcell-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary)) 8%,transparent)}
        .dt-panel-navcell-active::before{transform:translateY(-50%) scaleY(1)}
        /* 标题栏：图纸序号章（01 / 19）。 */
        .dt-panel-heading{display:flex;align-items:center;gap:10px;min-width:0}
        .dt-panel-heading h2{letter-spacing:.01em}
        .dt-panel-heading-index{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;letter-spacing:.06em;color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));padding:2px 7px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary)) 8%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary)) 22%,transparent)}
        /* 内容带：眉题前置 3px 签条，全分区统一图纸语汇。 */
        .dt-settings-band>h3{display:flex;align-items:center;gap:8px}
        .dt-settings-band>h3::before{content:"";flex:none;width:3px;height:12px;border-radius:2px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary))}
        /* 资产卡：发丝环统一悬浮反馈。 */
        .dt-card,.dt-persona-row,.dt-world-row,.dt-entry,.dt-regex-row,.dt-novel-card,.dt-mod-row,.dt-preset-row,.dt-script-row,.dt-guide-row,.dt-workbench-plan,.dt-stat{transition:border-color .15s ease,background .15s ease,transform .15s ease}
        .dt-card:hover,.dt-world-row:hover,.dt-entry:hover,.dt-preset-row:hover,.dt-script-row:hover,.dt-workbench-plan:hover{border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
        /* 总览统计：26px 等宽大数字 + 悬浮起 1px + 荧光环 + 按压回弹。 */
        .dt-stat{gap:4px;padding:14px;border-radius:10px}
        .dt-stat:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary)) 45%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary)) 5%,transparent)}
        .dt-stat:active{transform:translateY(0) scale(.98)}
        .dt-stat-value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;line-height:30px;letter-spacing:-.02em}
        .dt-stat-label{font-size:11px}
        /* 分区切换：内容带错峰浮入（纯 CSS 关键帧，零运行时依赖，GSAP 与无依赖
           bundle 纪律冲突——按 The Algorithm 删除该需求）。 */
        @keyframes dt-sheet-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .dt-panel-body>*{animation:dt-sheet-in .2s cubic-bezier(.2,.8,.2,1) both}
        .dt-panel-body>*:nth-child(2){animation-delay:.03s}
        .dt-panel-body>*:nth-child(3){animation-delay:.06s}
        .dt-panel-body>*:nth-child(4){animation-delay:.09s}
        .dt-panel-body>*:nth-child(5){animation-delay:.12s}
        /* 移动端横条：图纸序号与签条退场（独立断点后置于锁定行，不触碰契约行）。 */
        @media(max-width:700px){.dt-panel-navcell-index{display:none}.dt-panel-navcell::before{display:none}.dt-panel-heading-index{display:none}.dt-panel-group{margin-top:0;padding-top:0;border-top:0}.dt-kv-row{grid-template-columns:1fr 1fr 28px}}
        @media(prefers-reduced-motion:reduce){.dt-panel-body>*,.dt-stat,.dt-panel-navcell,.dt-panel-navcell::before{animation:none!important;transition:none!important}}
        /* 变量键值对（2026-10-23 用户反馈「都挤一块了」）：键/值输入走等宽字体，
           键列加宽到 220px，操作按钮行与清单之间留 12px 呼吸位，行间 8px。 */
        .dt-kv-list{gap:8px;max-width:720px}
        .dt-kv-row{grid-template-columns:minmax(140px,220px) minmax(0,1fr) 28px}
        .dt-kv-list+.dt-imports{margin-top:12px}
        .dt-kv-row input{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
        /* Body edit/regenerate dialogs (2026-10-29 user request): the editor
           fills the modal body height instead of keeping a fixed textarea
           height, so the field bottom aligns with the dialog footer. */
        .dt-body-dialog .dt-editor-modal-body>.dt-editor{flex:1;min-height:0}
        .dt-editor-field.dt-body-textarea{flex:1;min-height:0}
        .dt-editor-field.dt-body-textarea textarea{flex:1;height:auto;min-height:120px;max-height:none;resize:none;overflow-y:auto}
        /* 聊天渠道（提案 0024 §6.1）：三张通道卡 + 扫码带 + 绑定表 + 设置。
           状态灯走既有 state token（成功/警示/错误/业务主色），不引入新色板。 */
        .dt-im-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
        .dt-im-card{display:flex;flex-direction:column;gap:9px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-im-card-head{display:flex;align-items:center;gap:9px;min-width:0}
        .dt-im-light{flex:none;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.55}
        .dt-im-light-online{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary));opacity:1}
        .dt-im-light-scanning{background:var(--dsw-alias-state-business-primary);opacity:1;animation:dt-im-pulse 1.2s ease-in-out infinite}
        .dt-im-light-starting{background:var(--dsw-alias-state-business-primary);opacity:.7}
        .dt-im-light-paused{background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary));opacity:1}
        .dt-im-light-error{background:var(--dsw-alias-state-error-primary);opacity:1}
        @keyframes dt-im-pulse{50%{opacity:.35}}
        .dt-im-card-title{display:flex;flex-direction:column;min-width:0;flex:1}
        .dt-im-card-title strong{font-size:13px;line-height:19px}
        .dt-im-card-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-im-card-reason{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;overflow-wrap:anywhere}
        .dt-im-accounts{display:flex;flex-direction:column;gap:6px}
        .dt-im-account{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
        .dt-im-account-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
        .dt-im-account-copy strong{font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-im-account-copy span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
        .dt-im-account-actions{display:flex;gap:2px;flex:none}
        .dt-im-card-actions{display:flex;gap:8px;flex-wrap:wrap}
        .dt-im-install{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-im-monospace{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;overflow-wrap:anywhere;user-select:text}
        .dt-im-url{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
        .dt-im-url>code{flex:1;min-width:120px}
        .dt-im-bind{display:flex;flex-direction:column;gap:10px}
        .dt-im-bind-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-im-qr{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px}
        .dt-im-qr>img{width:220px;height:220px;max-width:100%;object-fit:contain;border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
        .dt-im-qr-link{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere;text-align:center}
        .dt-im-qr-link:hover,.dt-im-qr-link:focus-visible{text-decoration:underline}
        .dt-im-verify{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
        .dt-im-verify>.dt-hint{flex-basis:100%;margin:0}
        .dt-im-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end;gap:10px;max-width:620px}
        .dt-im-form>button{justify-self:start}
        .dt-im-endpoint{display:flex;flex-direction:column;gap:6px;margin-top:12px}
        .dt-im-endpoint>.dt-label{margin:0}
        .dt-im-endpoint>.dt-hint{margin:0}
        .dt-im-ws{user-select:text}
        .dt-im-peers{display:flex;flex-direction:column;gap:8px}
        .dt-im-peer{display:flex;flex-direction:column;gap:5px;min-width:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
        .dt-im-peer-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
        .dt-im-peer-key{flex:1;min-width:140px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:17px;overflow-wrap:anywhere}
        .dt-im-peer-chat{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
        .dt-im-peer>.dt-hint{margin:0}
        .dt-im-peer-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-im-peer-actions select{box-sizing:border-box;height:30px;max-width:min(320px,100%);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 8px;font:inherit;font-size:12px}
        .dt-im-settings{display:flex;flex-direction:column;gap:8px;max-width:560px}
        .dt-im-settings>.dt-hint{margin:0}
        .dt-im-settings>.dt-toggle{min-height:0}
        .dt-im-allow{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
        .dt-im-allow>label>.dt-hint{margin:0}
        .dt-im-allow textarea{box-sizing:border-box;width:100%;min-height:72px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:7px 9px;font:inherit;font-size:12px;line-height:18px}
        .dt-im-notice{margin:0;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px}
        @media(max-width:700px){.dt-im-allow{grid-template-columns:1fr}.dt-im-qr>img{width:180px;height:180px}}
        @media(prefers-reduced-motion:reduce){.dt-im-light-scanning{animation:none}}
      `
      document.head.appendChild(tag)
    }
