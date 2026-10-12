(function (root, factory) {
    const lists = factory();
    if (typeof module === 'object' && module.exports) module.exports = lists;
    else {
        root.WBDLLists = lists;
        root.WBDLList = lists.get(lists.fromHost(root.location.hostname));
        document.documentElement.dataset.list = root.WBDLList.id;
    }
})(typeof window === 'undefined' ? globalThis : window, function () {
    const definitions = {
        primary: {
            id: 'primary', label: 'Main List', shortName: 'WBDL',
            brand: 'Web Browser Demonlist', title: 'WBDL | Web Browser Demon List',
            description: "The unofficial ranking for the hardest levels beaten in 'Geometry Dash: Try Me!'.",
            icon: '/assets/icon.png', color: '#00e676', subdomain: ''
        },
        impossible: {
            id: 'impossible', label: 'Impossible List', shortName: 'WBILL',
            brand: 'WBDL Impossible List', title: 'WBILL | Web Browser Impossible List',
            description: 'The Web Browser Impossible List ranks the hardest unverified levels in Web Dashers.',
            icon: '/assets/impossible.png', color: '#ff4444', subdomain: 'impossible'
        },
        challenge: {
            id: 'challenge', label: 'Challenge List', shortName: 'WBCL',
            brand: 'Web Browser Challenge List', title: 'WBCL | Web Browser Challenge List',
            description: "The unofficial ranking for the hardest challenges beaten in 'Geometry Dash: Try Me!'.",
            icon: '/assets/challenge.png', color: '#b77bff', subdomain: 'challenge'
        }
    };

    function fromHost(host) {
        const hostname = String(host || '').toLowerCase().split(':')[0];
        if (hostname.startsWith('impossible.')) return 'impossible';
        if (hostname.startsWith('challenge.')) return 'challenge';
        return 'primary';
    }

    function get(id) { return definitions[id] || definitions.primary; }

    function url(id, location, pathname = '/') {
        const config = get(id);
        const baseHost = String(location.host).replace(/^(?:impossible|challenge)\./i, '');
        return `${location.protocol}//${config.subdomain ? config.subdomain + '.' : ''}${baseHost}${pathname}`;
    }

    return { definitions, fromHost, get, url };
});
