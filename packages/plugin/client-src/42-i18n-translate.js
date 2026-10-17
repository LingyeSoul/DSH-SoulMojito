    // translate follows the host locale service once apply() binds it; the
    // identity fallback mirrors LocaleRuntime.translate (missing key -> key,
    // {param} interpolation) for pre-apply and stubbed environments.
    let translate = (key, params) => {
      if (!params) return key
      return key.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
    }
    let subscribeLocale = () => () => {}
    let getLocaleRevision = () => ({ revision: 0 })

    function useTranslate() {
      useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision)
      return translate
    }