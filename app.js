/**
 * RobotPat DX Portal - Main Application
 */

const App = {
    data: {
        rpas: [],
        runs: [],
        recordings: [],
        backlog: [],
        quickLinks: []
    },

    state: {
        currentPage: 'dashboard',
        searchQuery: '',
        filterDept: '',
        filterStatus: '',
        filterNoRecording: false,
        sortBy: 'savedAmount',
        sortDesc: true,
        // Auth State
        isAdmin: false,
        user: null,
        // Backlog State
        searchBacklogQuery: '',
        filterBacklogDept: '',
        filterBacklogPriority: '',
        filterBacklogStatus: '',
        sortBacklogBy: 'priority',
        sortBacklogDesc: true,
        // Calendar State
        calendarDate: new Date(),
        // Free Slot Finder State
        freeTerminal: null,
        freeCond: { freq: 'daily', dows: [1], dom: 1 },
        freeDur: 30,
        freeMonth: new Date(),
        freeAllTerminals: true
    },

    config: {
        apiUrl: 'https://script.google.com/macros/s/AKfycbxuezoDkAkYMaKUSWpTfIVx9tKewLsmwVZ-LcA_kjXYO4NxOW-3_wVw-zSmp_FxTp82/exec',
        hourlyWage: 1750,
        jsonPath: 'data/db.json'
    },

    async init() {
        console.log('App initializing...');

        // まずローカルデータで即座に描画し、その後サーバーから最新を取得する
        this.loadLocalData();
        this.ensureDataDefaults();

        // インラインスタイルのリセット（詳細度問題の解決）
        document.querySelectorAll('.view-section').forEach(el => {
            el.style.display = '';
        });

        this.bindEvents();
        this.populateFilterOptions();
        this.checkSession();
        this.handleRoute(); // 初期ルート処理
        feather.replace();

        await this.loadData();
    },

    async loadData() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(`${this.config.apiUrl}?action=data`, {
                redirect: 'follow',
                signal: controller.signal
            });
            clearTimeout(timer);
            const json = await res.json();
            if (!json.ok) throw new Error(json.error || 'api_error');

            // Supabase時代の旧キャッシュを上書き前に一度だけ退避（データ救出用）
            const prev = localStorage.getItem('rpa_portal_data');
            if (prev && !localStorage.getItem('rpa_portal_data_backup')) {
                localStorage.setItem('rpa_portal_data_backup', prev);
            }

            this.data = json.data;
            this.ensureDataDefaults();
            localStorage.setItem('rpa_portal_data', JSON.stringify(this.data));
            console.log('Data loaded from API');

            this.populateFilterOptions();
            this.handleRoute();
            feather.replace();
        } catch (error) {
            console.error('Data load error:', error);
        }
    },

    ensureDataDefaults() {
        if (!this.data) this.data = {};
        ['rpas', 'runs', 'recordings', 'backlog'].forEach(k => {
            if (!Array.isArray(this.data[k])) this.data[k] = [];
        });
        if (!this.data.terminals) this.data.terminals = window.initialData?.terminals || [];
        if (!this.data.schedules) this.data.schedules = window.initialData?.schedules || [];
        this.normalizeSchedules();
        this._occCache = {};
        this._archivedMemo = {};

        // Default Quick Links if none exist
        if (!this.data.quickLinks || this.data.quickLinks.length === 0) {
            this.data.quickLinks = [
                { id: 'ql-1', name: 'RPAスケジュール', url: 'https://docs.google.com/spreadsheets/d/1fik8PJjDNwv4xfIseCUD8_oBqbxxOSlpuDM_6x1aP3I/edit?usp=sharing', icon: 'calendar' },
                { id: 'ql-2', name: 'RPA実績報告書', url: 'https://docs.google.com/spreadsheets/d/1aKg7bkAisIC4OCO_RPu7dTPpx1iOIhdnURYNgJma13U/edit?usp=sharing', icon: 'file-text' }
            ];
        }
    },

    loadLocalData() {
        const stored = localStorage.getItem('rpa_portal_data');
        if (stored) {
            this.data = JSON.parse(stored);
            console.log('Data loaded from localStorage');
        } else if (window.initialData) {
            this.data = window.initialData;
            console.log('Data loaded from initialData');
        }
        if (!this.data.quickLinks) this.data.quickLinks = [];
    },

    async apiPost(payload) {
        const res = await fetch(this.config.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            redirect: 'follow'
        });
        return res.json();
    },

    async syncToServer() {
        if (!this.state.isAdmin) return;
        try {
            const json = await this.apiPost({
                action: 'save',
                password: this.getAdminKey(),
                data: this.data
            });
            if (!json.ok) throw new Error(json.error || 'save_failed');
            console.log('Data synced to server');
            if (json.addedToJisseki && json.addedToJisseki.length > 0) {
                console.log('実績一覧に行追加:', json.addedToJisseki.join(', '));
            }
        } catch (error) {
            console.error('Server sync error:', error);
            alert('サーバーへの保存に失敗しました。ネットワークを確認して再度保存してください。\n' + error.message);
        }
    },

    saveData() {
        this._occCache = {};
        this._archivedMemo = {};
        localStorage.setItem('rpa_portal_data', JSON.stringify(this.data));
        if (this.state.isAdmin) {
            this.syncToServer();
        }
    },

    // --- Auth Logic ---

    getAdminKey() {
        return localStorage.getItem('rpa_admin_key') || '';
    },

    async checkSession() {
        const key = this.getAdminKey();
        this.state.isAdmin = !!key;
        this.updateAuthUI();
        if (!key) return;
        try {
            const json = await this.apiPost({ action: 'login', password: key });
            if (!json.ok) {
                localStorage.removeItem('rpa_admin_key');
                this.state.isAdmin = false;
                this.updateAuthUI();
            }
        } catch (error) {
            console.warn('Session check failed (offline?):', error);
        }
    },

    showLoginModal() {
        document.getElementById('login-modal').style.display = 'flex';
    },

    hideLoginModal() {
        document.getElementById('login-modal').style.display = 'none';
        document.getElementById('login-password').value = '';
    },

    async login() {
        const password = document.getElementById('login-password').value;
        if (!password) {
            alert('パスワードを入力してください');
            return;
        }

        try {
            const json = await this.apiPost({ action: 'login', password });
            if (!json.ok) {
                throw new Error(json.error === 'invalid_password' ? 'パスワードが違います' : (json.error || 'login_failed'));
            }

            localStorage.setItem('rpa_admin_key', password);
            this.state.isAdmin = true;
            this.hideLoginModal();
            this.updateAuthUI();
            alert('ログインしました');
        } catch (error) {
            console.error('Login error:', error);
            alert('ログインに失敗しました: ' + error.message);
        }
    },

    async logout() {
        localStorage.removeItem('rpa_admin_key');
        this.state.user = null;
        this.state.isAdmin = false;
        this.updateAuthUI();
        alert('ログアウトしました');
        window.location.hash = '#dashboard';
    },

    updateAuthUI() {
        const isAdmin = this.state.isAdmin;

        // Sidebar buttons
        document.getElementById('nav-login').style.display = isAdmin ? 'none' : 'flex';
        document.getElementById('nav-logout').style.display = isAdmin ? 'flex' : 'none';

        // Administrative actions
        const adminElements = [
            'add-rpa-btn',
            'add-backlog-btn',
            'add-schedule-btn',
            'manage-terminals-btn',
            'btn-import',
            'btn-reset'
        ];
        adminElements.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = isAdmin ? '' : 'none';
        });

        // "Data Management" nav item (Handle both a and div if any)
        document.querySelectorAll('.nav-item[data-page="data"]').forEach(el => {
            el.style.display = isAdmin ? 'flex' : 'none';
        });

        // Backlog Actions Column Header
        const backlogTable = document.getElementById('backlog-list-table');
        if (backlogTable) {
            const header = backlogTable.querySelector('thead th:last-child');
            if (header && (header.textContent.includes('操作') || header.innerHTML.includes('操作'))) {
                header.style.display = isAdmin ? '' : 'none';
            }
        }

        // Quick Links "Manage" button
        const qlManageBtn = document.querySelector('button[onclick="App.showQuickLinkModal()"]');
        if (qlManageBtn) qlManageBtn.style.display = isAdmin ? '' : 'none';

        // Refresh current page to hide/show edit icons
        this.handleRoute();
    },

    bindEvents() {
        // Routing
        window.addEventListener('hashchange', () => this.handleRoute());

        // RPA Registration Button
        document.getElementById('add-rpa-btn')?.addEventListener('click', () => {
            window.location.hash = '#rpa-edit';
        });
        // RPA List Filters
        document.getElementById('rpa-search').addEventListener('input', (e) => {
            this.state.searchQuery = e.target.value.toLowerCase();
            this.renderRpaList();
        });
        document.getElementById('filter-dept').addEventListener('change', (e) => {
            this.state.filterDept = e.target.value;
            this.renderRpaList();
        });
        document.getElementById('filter-status').addEventListener('change', (e) => {
            this.state.filterStatus = e.target.value;
            this.renderRpaList();
        });
        document.getElementById('filter-no-recording').addEventListener('change', (e) => {
            this.state.filterNoRecording = e.target.checked;
            this.renderRpaList();
        });

        // Backlog List Filters
        document.getElementById('backlog-search').addEventListener('input', (e) => {
            this.state.searchBacklogQuery = e.target.value.toLowerCase();
            this.renderBacklogList();
        });
        document.getElementById('filter-backlog-dept').addEventListener('change', (e) => {
            this.state.filterBacklogDept = e.target.value;
            this.renderBacklogList();
        });
        document.getElementById('filter-backlog-priority').addEventListener('change', (e) => {
            this.state.filterBacklogPriority = e.target.value;
            this.renderBacklogList();
        });
        document.getElementById('filter-backlog-status').addEventListener('change', (e) => {
            this.state.filterBacklogStatus = e.target.value;
            this.renderBacklogList();
        });

        // Tab Switching
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-btn')) {
                const tabId = e.target.dataset.tab;
                const container = e.target.closest('.view-section');
                if (!container) return;

                container.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');

                container.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
                const pane = container.querySelector(`#tab-${tabId}`);
                if (pane) pane.classList.add('active');
            }
        });

        // Sorting
        document.querySelectorAll('.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const sortKey = th.dataset.sort;
                const isBacklog = th.closest('#backlog-list-table');

                if (isBacklog) {
                    if (this.state.sortBacklogBy === sortKey) {
                        this.state.sortBacklogDesc = !this.state.sortBacklogDesc;
                    } else {
                        this.state.sortBacklogBy = sortKey;
                        this.state.sortBacklogDesc = true;
                    }
                    this.renderBacklogList();
                } else {
                    if (this.state.sortBy === sortKey) {
                        this.state.sortDesc = !this.state.sortDesc;
                    } else {
                        this.state.sortBy = sortKey;
                        this.state.sortDesc = true;
                    }
                    this.renderRpaList();
                }
                this.updateSortIcons();
                this.updateSortIcons();
            });
        });

        // Data Management Events
        document.getElementById('btn-export')?.addEventListener('click', () => this.exportData());
        document.getElementById('btn-import')?.addEventListener('click', () => {
            const fileInput = document.getElementById('file-import');
            if (fileInput.files.length > 0) {
                this.importData(fileInput.files[0]);
            } else {
                alert('ファイルを選択してください');
            }
        });
        document.getElementById('btn-reset')?.addEventListener('click', () => {
            if (confirm('本当にデータを初期化しますか？この操作は取り消せません。')) {
                this.resetData();
            }
        });

        // Backlog Add Button
        document.getElementById('add-backlog-btn')?.addEventListener('click', () => {
            this.showBacklogForm();
        });

        // Schedule Frequency Toggle
        const schFreq = document.getElementById('sch-frequency');
        if (schFreq) {
            schFreq.addEventListener('change', (e) => {
                const val = e.target.value;
                document.getElementById('sch-weekly-options').style.display = val === 'weekly' ? 'block' : 'none';
                document.getElementById('sch-monthly-options').style.display = val === 'monthly' ? 'block' : 'none';
                document.getElementById('sch-once-options').style.display = val === 'once' ? 'block' : 'none';
                this.renderScheduleModalConflict();
            });
        }
        ['sch-terminal', 'sch-start', 'sch-end', 'sch-day-of-month', 'sch-once-date'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this.renderScheduleModalConflict());
        });

        // Free Slot Finder Controls
        document.querySelectorAll('#free-freq button').forEach(btn => {
            btn.addEventListener('click', () => this.setFreeFreq(btn.dataset.f));
        });
        const freeDom = document.getElementById('free-dom');
        if (freeDom) {
            freeDom.innerHTML = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}日</option>`).join('');
            freeDom.addEventListener('change', (e) => {
                this.state.freeCond.dom = e.target.value;
                this.renderFreeSlots();
            });
        }
        document.getElementById('free-dur')?.addEventListener('change', (e) => {
            this.state.freeDur = Number(e.target.value);
            this.renderFreeSlots();
        });
        document.getElementById('free-allterm')?.addEventListener('change', (e) => {
            this.state.freeAllTerminals = e.target.checked;
            this.renderFreeCandidates();
        });
    },

    handleRoute() {
        const hash = window.location.hash || '#dashboard';
        const pageRaw = hash.replace('#', '');

        let page = pageRaw;
        let param = null;

        // Check for parameterized routes (e.g., rpa-detail/123)
        if (pageRaw.startsWith('rpa-detail/')) {
            const parts = pageRaw.split('/');
            page = parts[0];
            param = parts[1];
        } else if (pageRaw.startsWith('rpa-edit')) {
            const parts = pageRaw.split('/');
            page = 'rpa-edit';
            param = parts[1]; // undefined if new
        }

        // Access Control
        const adminPages = ['rpa-edit', 'data'];
        if (adminPages.includes(page) && !this.state.isAdmin) {
            console.warn('Unauthorized access to admin page:', page);
            window.location.hash = '#dashboard';
            return;
        }

        this.state.currentPage = page;

        // View Visibility
        document.querySelectorAll('.view-section').forEach(el => {
            el.style.display = ''; // Reset inline style
            if (el.id === `view-${page}`) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });

        // Sidebar Active State
        document.querySelectorAll('.nav-item').forEach(el => {
            // Remove active from all first
            el.classList.remove('active');

            // Exact match or prefix match
            const navPage = el.dataset.page;
            if (navPage === page) {
                el.classList.add('active');
            }
            // RPA Detail should highlight RPA List nav
            if (page === 'rpa-detail' && navPage === 'rpas') {
                el.classList.add('active');
            }
        });

        // Page Title update
        const pageTitles = {
            'dashboard': 'ダッシュボード',
            'schedule': '稼働スケジュール',
            'rpas': 'RPA一覧',
            'rpa-detail': 'RPA詳細',
            'backlog': '開発バックログ',
            'data': 'データ管理'
        };
        document.getElementById('page-title').textContent = pageTitles[page] || 'RPA Portal';

        // Render Page Content
        if (page === 'dashboard') {
            this.renderDashboard();
        } else if (page === 'schedule') {
            this.renderSchedule();
        } else if (page === 'rpas') {
            this.renderRpaList();
        } else if (page === 'backlog') {
            this.renderBacklogList();
        } else if (page === 'rpa-detail' && param) {
            this.renderRpaDetail(param);
        } else if (page === 'rpa-edit') {
            this.renderRpaEdit(param);
        } else if (page === 'data') {
            // No specific render logic needed for data view yet
        }

        feather.replace();
    },

    populateFilterOptions() {
        // 部署一覧の生成
        const depts = [...new Set(this.data.rpas.map(r => r.department))].sort();
        const select = document.getElementById('filter-dept');
        select.innerHTML = '<option value="">全部署</option>';
        depts.forEach(dept => {
            const option = document.createElement('option');
            option.value = dept;
            option.textContent = dept;
            select.appendChild(option);
        });

        // バックログ部署一覧
        const backlogDepts = [...new Set(this.data.backlog.map(b => b.department))].sort();
        const backlogSelect = document.getElementById('filter-backlog-dept');
        backlogSelect.innerHTML = '<option value="">全部署</option>';
        backlogDepts.forEach(dept => {
            const option = document.createElement('option');
            option.value = dept;
            option.textContent = dept;
            backlogSelect.appendChild(option);
        });
    },

    // --- Helper ---

    getCalculatedRpaData() {
        // Runsデータをもとに集計値を計算して合体（必要なら）
        // 現状はsavedMinutesなどがRPAデータ自体に含まれているためそのまま返す
        // 将来的にrunsテーブルから動的計算する場合ここを拡張
        return this.data.rpas.map(r => {
            // 念のためrunsの集計も加算するロジックを入れておく？
            // いえ、saveRpaで計算済みデータを持っているので、二重計上を避けるためそのまま返します。
            return r;
        });
    },

    // --- Dashboard Logic ---

    renderDashboard() {
        const stats = this.calculateDashboardStats();

        document.getElementById('kpi-saved-amount').textContent = stats.totalSavedAmount.toLocaleString();
        document.getElementById('kpi-saved-hours').textContent = stats.totalSavedHours.toLocaleString(undefined, { maximumFractionDigits: 1 });
        document.getElementById('kpi-active-rpas').textContent = stats.activeRpaCount;
        document.getElementById('kpi-run-count').textContent = stats.totalRunCount;
        document.getElementById('kpi-backlog-savings').textContent = Math.round(stats.totalBacklogSavedHours).toLocaleString();

        this.renderTopRanking(stats.rpaStats);
        this.renderTrendChart(stats.monthlyStats);
        this.renderQuickLinks();
    },

    calculateDashboardStats() {
        const rpaStats = this.getCalculatedRpaData();

        // rpaStatsから総削減時間・金額を計算（RPA直接入力値 + runs集計値）
        const totalSavedMinutes = rpaStats.reduce((sum, r) => sum + (r.savedMinutes || 0), 0);
        const totalSavedAmount = rpaStats.reduce((sum, r) => sum + (r.savedAmount || 0), 0);

        // 実行回数：RPA直接入力値 + runs集計値
        const runsRunCount = this.data.runs.reduce((sum, run) => sum + (run.runCount || 1), 0);
        const rpaRunCount = rpaStats.reduce((sum, r) => sum + (r.runCount || 0), 0);
        const totalRunCount = rpaRunCount + runsRunCount;

        // バックログ見込み削減時間の計算
        const pendingBacklog = (this.data.backlog || []).filter(item => item.status === 'Todo' || item.status === 'In Progress');
        const totalBacklogSavedMinutes = pendingBacklog.reduce((sum, item) => sum + (item.expectedSavedMinutesPerRun || 0), 0);
        const totalBacklogSavedHours = totalBacklogSavedMinutes / 60;

        rpaStats.sort((a, b) => b.savedAmount - a.savedAmount);

        return {
            totalSavedAmount,
            totalSavedHours: totalSavedMinutes / 60,
            activeRpaCount: this.data.rpas.length,
            totalRunCount,
            totalBacklogSavedHours,
            rpaStats,
            monthlyStats: this.calculateMonthlyStats()
        };
    },

    calculateMonthlyStats() {
        // TODO: データから真面目に計算するロジックへ更新推奨
        return {
            labels: ['10月', '11月', '12月', '1月'],
            data: [150000, 180000, 210000, 190000]
        };
    },

    renderTopRanking(rpaStats) {
        const tbody = document.querySelector('#top-rpa-table tbody');
        tbody.innerHTML = '';

        rpaStats.slice(0, 5).forEach(stat => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${stat.name}</td>
                <td class="text-right font-bold">¥${stat.savedAmount.toLocaleString()}</td>
            `;
            tbody.appendChild(tr);
        });
    },

    renderTrendChart(monthlyStats) {
        const canvas = document.getElementById('trendChart');
        if (!canvas) return;

        // 既存のチャートがあれば破棄（Canvas再利用のため）
        const existingChart = Chart.getChart(canvas);
        if (existingChart) existingChart.destroy();

        const ctx = canvas.getContext('2d');
        Chart.defaults.color = '#94A3B8';
        Chart.defaults.borderColor = 'rgba(148, 163, 184, 0.1)';

        new Chart(ctx, {
            type: 'line',
            data: {
                labels: monthlyStats.labels,
                datasets: [{
                    label: '削減金額 (円)',
                    data: monthlyStats.data,
                    borderColor: '#3B82F6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    },

    // --- RPA List Logic ---

    getCalculatedRpaData() {
        // 全RPAについて、Runsを集計して結合
        return this.data.rpas.map(rpa => {
            const rpaRuns = this.data.runs.filter(r => r.rpaId === rpa.id);
            const runsMinutes = rpaRuns.reduce((sum, r) => sum + (r.savedMinutes || 0), 0);

            // RPA自体に設定された削減時間 + 実行実績からの削減時間
            const savedMinutes = (rpa.savedMinutes || 0) + runsMinutes;
            const savedAmount = Math.floor(savedMinutes / 60 * this.config.hourlyWage);

            // 録画情報: RPA直接入力優先、なければrecordingsテーブルから
            const recording = this.data.recordings.find(r => r.rpaId === rpa.id);
            const recordingUrl = rpa.recordingUrl || (recording ? recording.url : null);

            return {
                ...rpa,
                savedMinutes,
                savedAmount,
                hasRecording: !!recordingUrl,
                recordingUrl
            };
        });
    },

    renderRpaList() {
        let rpas = this.getCalculatedRpaData();

        // 1. Filter
        if (this.state.searchQuery) {
            const q = this.state.searchQuery;
            rpas = rpas.filter(r =>
                r.name.toLowerCase().includes(q) ||
                r.tags.some(t => t.toLowerCase().includes(q)) ||
                r.department.toLowerCase().includes(q)
            );
        }
        if (this.state.filterDept) {
            rpas = rpas.filter(r => r.department === this.state.filterDept);
        }
        if (this.state.filterStatus) {
            rpas = rpas.filter(r => r.operationMode === this.state.filterStatus);
        }
        if (this.state.filterNoRecording) {
            rpas = rpas.filter(r => !r.hasRecording);
        }

        // 2. Sort
        const { sortBy, sortDesc } = this.state;
        rpas.sort((a, b) => {
            let valA = a[sortBy];
            let valB = b[sortBy];

            // 文字列比較
            if (typeof valA === 'string') {
                valA = valA.toLowerCase();
                valB = valB.toLowerCase();
            }

            if (valA < valB) return sortDesc ? 1 : -1;
            if (valA > valB) return sortDesc ? -1 : 1;
            return 0;
        });

        // 3. Render
        const tbody = document.querySelector('#rpa-list-table tbody');
        tbody.innerHTML = '';

        rpas.forEach(rpa => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = (e) => {
                if (e.target.closest('a')) return; // リンククリックは無視
                window.location.hash = `#rpa-detail/${rpa.id}`;
            };

            const statusBadge = rpa.operationMode === 'scheduled'
                ? '<span class="badge badge-green">自動</span>'
                : '<span class="badge badge-yellow">手動</span>';

            const recordingIcon = rpa.hasRecording
                ? `<a href="${rpa.recordingUrl}" target="_blank" class="text-primary hover:text-white" title="録画を見る"><i data-feather="video"></i></a>`
                : '<span class="text-muted" title="録画なし"><i data-feather="video-off"></i></span>';

            const sheetLink = rpa.sheetUrl
                ? `<a href="${rpa.sheetUrl}" target="_blank" class="text-secondary hover:text-white"><i data-feather="file-text"></i> Link</a>`
                : '<span class="text-muted">-</span>';

            tr.innerHTML = `
                <td>
                    <div style="font-weight: 500;">${rpa.name}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 2px;">
                        ${rpa.tags.map(tag => `#${tag}`).join(' ')}
                    </div>
                </td>
                <td><span class="badge badge-gray">${rpa.department}</span></td>
                <td>${statusBadge}</td>
                <td>${sheetLink}</td>
                <td style="text-align: center;">${recordingIcon}</td>
                <td class="text-right">${(rpa.savedMinutes / 60).toFixed(1)} h</td>
                <td class="text-right font-bold">¥${rpa.savedAmount.toLocaleString()}</td>
                <td><span style="font-size: 0.8rem; color: var(--text-muted);">${rpa.updatedAt ? new Date(rpa.updatedAt).toLocaleDateString() : '-'}</span></td>
            `;
            tbody.appendChild(tr);
        });

        feather.replace();
    },

    renderRpaDetail(id) {
        const rpa = this.getCalculatedRpaData().find(r => r.id === id);
        if (!rpa) {
            alert('RPAデータが見つかりません');
            window.location.hash = '#rpas';
            return;
        }

        // Header
        document.getElementById('detail-rpa-name').textContent = rpa.name;
        const statusBadge = document.getElementById('detail-rpa-status');
        statusBadge.className = `badge ${rpa.operationMode === 'scheduled' ? 'badge-green' : 'badge-yellow'}`;
        statusBadge.textContent = rpa.operationMode === 'scheduled' ? '自動実行' : '手動実行';

        // Edit Button (ID update) - Only show for admin
        const editBtn = document.querySelector('.detail-header button.btn-secondary') || document.querySelector('.detail-header .btn-primary');
        if (editBtn) {
            editBtn.style.display = this.state.isAdmin ? '' : 'none';
            editBtn.onclick = (e) => {
                e.preventDefault();
                this.goToEdit(rpa.id);
            };
        }

        // Tab: Overview
        document.getElementById('detail-dept').textContent = rpa.department;
        document.getElementById('detail-desc').textContent = rpa.description || '説明なし';
        document.getElementById('detail-dev-hours').textContent = rpa.devHours ? `${rpa.devHours}時間` : '-';
        document.getElementById('detail-total-saved').textContent = `${(rpa.savedMinutes / 60).toFixed(1)}時間`;
        document.getElementById('detail-total-amount').textContent = `¥${rpa.savedAmount.toLocaleString()}`;

        const tagsContainer = document.getElementById('detail-tags');
        tagsContainer.innerHTML = rpa.tags.map(tag => `<span class="badge badge-gray">#${tag}</span>`).join('');

        // Spreadsheets List
        const sheetLinksContainer = document.getElementById('detail-sheet-links');
        sheetLinksContainer.innerHTML = '';

        if (rpa.sheets && rpa.sheets.length > 0) {
            rpa.sheets.forEach(s => {
                const link = document.createElement('a');
                link.href = s.url;
                link.target = '_blank';
                link.className = 'text-secondary hover:text-white flex items-center gap-1 text-sm';
                link.innerHTML = `<i data-feather="external-link" width="14"></i> ${s.name}`;
                sheetLinksContainer.appendChild(link);
            });
        } else if (rpa.sheetUrl) {
            // Backward compatibility
            sheetLinksContainer.innerHTML = `<a href="${rpa.sheetUrl}" target="_blank" class="text-secondary hover:text-white flex items-center gap-1 text-sm"><i data-feather="external-link" width="14"></i> Open Sheet</a>`;
        } else {
            sheetLinksContainer.textContent = '-';
        }

        // Tab: Runs
        const runsTbody = document.querySelector('#detail-runs-table tbody');
        runsTbody.innerHTML = '';
        const rpaRuns = this.data.runs.filter(r => r.rpaId === id).sort((a, b) => new Date(b.executedAt) - new Date(a.executedAt));

        if (rpaRuns.length === 0) {
            runsTbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">実行履歴はありません</td></tr>';
        } else {
            rpaRuns.forEach(run => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${new Date(run.executedAt).toLocaleString()}</td>
                    <td class="text-right">${(run.savedMinutes / 60).toFixed(1)} h</td>
                    <td class="text-right">${(run.actualMinutes / 60).toFixed(1)} h</td>
                    <td class="text-right">${run.runCount || 1}</td>
                    <td class="text-sm text-muted">${run.note || ''}</td>
                `;
                runsTbody.appendChild(tr);
            });
        }

        // Tab: Recordings
        const recordingsList = document.getElementById('detail-recordings-list');
        recordingsList.innerHTML = '';
        const recs = this.data.recordings.filter(r => r.rpaId === id).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));

        if (recs.length === 0 && !rpa.recordingUrl) {
            recordingsList.innerHTML = '<div class="text-center text-muted py-4">録画データはありません</div>';
        } else {
            // RPA Manual Recording URL
            if (rpa.recordingUrl) {
                const item = document.createElement('div');
                item.className = 'glass-panel flex justify-between items-center p-4 mb-2';
                item.style.background = 'rgba(255,255,255,0.03)';
                item.innerHTML = `
                    <div>
                        <div class="font-medium mb-1">登録済み録画リンク</div>
                        <div class="text-xs text-muted">Googleドライブ等</div>
                    </div>
                    <a href="${rpa.recordingUrl}" target="_blank" class="btn btn-primary text-sm flex items-center gap-2">
                        <i data-feather="play-circle" width="16"></i> 再生
                    </a>
                `;
                recordingsList.appendChild(item);
            }

            // DB Recordings
            recs.forEach(rec => {
                const item = document.createElement('div');
                item.className = 'glass-panel flex justify-between items-center p-4 mb-2';
                item.style.background = 'rgba(255,255,255,0.03)';
                item.innerHTML = `
                    <div>
                        <div class="font-medium mb-1">${rec.title}</div>
                        <div class="text-xs text-muted">${new Date(rec.recordedAt).toLocaleString()}</div>
                    </div>
                    <a href="${rec.url}" target="_blank" class="btn btn-primary text-sm flex items-center gap-2">
                        <i data-feather="play-circle" width="16"></i> 再生
                    </a>
                `;
                recordingsList.appendChild(item);
            });
        }

        // Reset tabs to first one
        document.querySelector('.tab-btn[data-tab="overview"]').click();

        feather.replace();
    },

    goToEdit(id) {
        if (!id) {
            // Try to infer from hash if on detail page
            const hash = window.location.hash;
            if (hash.startsWith('#rpa-detail/')) {
                id = hash.split('/')[1];
            }
        }
        if (id) {
            window.location.hash = `#rpa-edit/${id}`;
        } else {
            window.location.hash = '#rpa-edit';
        }
    },

    addSheetInput(name = '', url = '') {
        const container = document.getElementById('edit-sheets-container');
        const div = document.createElement('div');
        div.className = 'flex gap-2 items-center sheet-input-group';
        div.style.marginBottom = '5px';
        div.innerHTML = `
            <input type="text" class="form-control" style="width: 30%;" placeholder="表示名 (例: 管理表)" value="${name}">
            <input type="url" class="form-control" style="flex: 1;" placeholder="https://docs.google.com/..." value="${url}">
            <button type="button" class="btn btn-ghost btn-sm text-red-400" onclick="this.parentElement.remove()" title="削除">
                <i data-feather="x" width="16"></i>
            </button>
        `;
        container.appendChild(div);
        feather.replace();
    },

    renderRpaEdit(id) {
        // Handle "undefined" string from URL
        if (id === 'undefined' || id === 'null' || id === '') id = null;

        // Dynamic Department Options
        const deptSelect = document.getElementById('edit-department');
        const existingDepts = new Set(this.data.rpas.map(r => r.department));
        ['全社', '本社', '支店', 'ESキッチン', 'BMC秋津'].forEach(d => existingDepts.add(d));
        deptSelect.innerHTML = Array.from(existingDepts).sort().map(d => `<option value="${d}">${d}</option>`).join('');

        const container = document.getElementById('edit-sheets-container');
        container.innerHTML = ''; // Reset

        if (id) {
            // Edit Mode
            const rpa = this.data.rpas.find(r => r.id === id);
            if (!rpa) return;

            document.getElementById('edit-page-title').textContent = 'RPA編集';
            document.getElementById('edit-id').value = rpa.id;
            document.getElementById('edit-name').value = rpa.name;
            document.getElementById('edit-department').value = rpa.department;

            // Sheets Handling
            if (rpa.sheets && rpa.sheets.length > 0) {
                rpa.sheets.forEach(s => this.addSheetInput(s.name, s.url));
            } else if (rpa.sheetUrl) {
                // Compatibility migration
                this.addSheetInput('メイン', rpa.sheetUrl);
            } else {
                this.addSheetInput(); // Empty
            }

            document.getElementById('edit-recordingUrl').value = rpa.recordingUrl || '';
            document.getElementById('edit-devHours').value = rpa.devHours || '';
            document.getElementById('edit-savedHours').value = rpa.savedMinutes ? (rpa.savedMinutes / 60) : '';
            document.getElementById('edit-runCount').value = rpa.runCount || '';
            document.getElementById('edit-tags').value = rpa.tags.join(', ');
            document.getElementById('edit-description').value = rpa.description || '';

            const mode = rpa.operationMode === 'manual' ? 'manual' : 'scheduled';
            document.getElementsByName('operationMode').forEach(el => {
                el.checked = (el.value === mode);
            });

            // 実績一覧シートと連動しているRPAは数値実績をシート側で管理する
            const lockMetrics = !!rpa.sheetLinked;
            ['edit-savedHours', 'edit-runCount'].forEach(id => {
                const el = document.getElementById(id);
                el.disabled = lockMetrics;
                el.title = lockMetrics ? '実績一覧シートで管理されています（シート側で編集してください）' : '';
            });
        } else {
            // Create Mode
            document.getElementById('edit-page-title').textContent = 'RPA登録';
            document.getElementById('edit-id').value = '';

            this.addSheetInput(); // Empty initial input

            document.getElementById('edit-savedHours').value = '';
            document.getElementById('edit-runCount').value = '';
            document.getElementById('edit-recordingUrl').value = '';

            ['edit-savedHours', 'edit-runCount'].forEach(id => {
                const el = document.getElementById(id);
                el.disabled = false;
                el.title = '';
            });
        }

        feather.replace();
    },

    saveRpa() {
        const id = document.getElementById('edit-id').value;
        const name = document.getElementById('edit-name').value;
        const department = document.getElementById('edit-department').value;

        // Collect Sheets
        const sheets = [];
        document.querySelectorAll('.sheet-input-group').forEach(group => {
            const inputs = group.querySelectorAll('input');
            const sName = inputs[0].value.trim();
            const sUrl = inputs[1].value.trim();
            if (sUrl) {
                sheets.push({ name: sName || 'シート', url: sUrl });
            }
        });

        const recordingUrl = document.getElementById('edit-recordingUrl').value;
        const devHours = parseFloat(document.getElementById('edit-devHours').value) || 0;
        const savedHours = parseFloat(document.getElementById('edit-savedHours').value) || 0;
        const savedMinutes = savedHours * 60;
        const savedAmount = Math.round(savedHours * 1750);
        const runCount = parseInt(document.getElementById('edit-runCount').value) || 0;
        const tagsStr = document.getElementById('edit-tags').value;
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
        const description = document.getElementById('edit-description').value;

        let operationMode = 'scheduled';
        document.getElementsByName('operationMode').forEach(el => {
            if (el.checked) operationMode = el.value;
        });

        const now = new Date().toISOString();

        const rpaData = {
            name, department, sheets, recordingUrl, devHours, tags, description, operationMode,
            savedMinutes, savedAmount, runCount,
            updatedAt: now
        };

        if (id) {
            // Update
            const rpaIndex = this.data.rpas.findIndex(r => r.id === id);
            if (rpaIndex > -1) {
                this.data.rpas[rpaIndex] = {
                    ...this.data.rpas[rpaIndex],
                    ...rpaData,
                    sheetUrl: sheets.length > 0 ? sheets[0].url : '' // Backward compatibility
                };
            }
        } else {
            // Create
            const newId = 'rpa-' + Date.now();
            const newRpa = {
                id: newId,
                ...rpaData,
                sheetUrl: sheets.length > 0 ? sheets[0].url : '', // Backward compatibility
                createdAt: now,
                syncToSheet: true // 保存時に実績一覧シートへ行を自動追加
            };
            this.data.rpas.push(newRpa);
        }

        this.saveData();
        alert('保存しました');
        window.location.hash = '#rpas';
    },

    // --- Data Management Logic ---

    exportData() {
        const blob = new Blob([JSON.stringify(this.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rpa_portal_backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    importData(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                // Validate structure roughly
                if (json.rpas && json.runs) {
                    this.data = json;
                    this.saveData();
                    alert('データのインポートが完了しました');
                    location.reload();
                } else {
                    throw new Error('Invalid data format');
                }
            } catch (error) {
                console.error('Import error:', error);
                alert('ファイルの読み込みに失敗しました。正しいJSONファイルか確認してください。');
            }
        };
        reader.readAsText(file);
    },

    resetData() {
        localStorage.removeItem('rpa_portal_data');
        alert('データを初期化しました');
        location.reload();
    },

    updateSortIcons() {
        document.querySelectorAll('.sortable').forEach(th => {
            th.classList.remove('asc', 'desc');
            const isBacklog = th.closest('#backlog-list-table');
            const targetSortBy = isBacklog ? this.state.sortBacklogBy : this.state.sortBy;
            const targetSortDesc = isBacklog ? this.state.sortBacklogDesc : this.state.sortDesc;

            if (th.dataset.sort === targetSortBy) {
                th.classList.add(targetSortDesc ? 'desc' : 'asc');
            }
        });
    },

    // --- Backlog Registration ---

    getPriorityValue(priority) {
        const map = { 'High': 3, 'Medium': 2, 'Low': 1 };
        return map[priority] || 0;
    },

    showBacklogForm() {
        document.getElementById('backlog-form-container').style.display = 'block';
        document.getElementById('backlog-form').reset();
        document.getElementById('backlog-id').value = '';
        feather.replace();
    },

    hideBacklogForm() {
        document.getElementById('backlog-form-container').style.display = 'none';
    },

    saveBacklog() {
        const id = document.getElementById('backlog-id').value;
        const title = document.getElementById('backlog-title').value;
        const department = document.getElementById('backlog-department').value;
        const priority = document.getElementById('backlog-priority').value;
        const status = document.getElementById('backlog-status').value;
        const expectedSavedHours = parseFloat(document.getElementById('backlog-savedHours').value) || 0;
        const expectedSavedMinutesPerRun = Math.round(expectedSavedHours * 60);
        const notes = document.getElementById('backlog-notes').value;

        if (!this.data.backlog) {
            this.data.backlog = [];
        }

        if (id) {
            // Edit
            const index = this.data.backlog.findIndex(b => b.id === id);
            if (index > -1) {
                this.data.backlog[index] = {
                    ...this.data.backlog[index],
                    title, department, priority, status, expectedSavedMinutesPerRun, notes
                };
                alert('バックログを更新しました');
            }
        } else {
            // New
            const newId = 'bl-' + Date.now();
            const newBacklog = {
                id: newId,
                title,
                department,
                priority,
                status,
                expectedSavedMinutesPerRun,
                notes
            };
            this.data.backlog.push(newBacklog);
            alert('バックログを登録しました');
        }

        this.saveData();
        this.hideBacklogForm();
        this.renderBacklogList();
        feather.replace();
    },

    renderBacklogList() {
        let items = [...(this.data.backlog || [])];

        // 1. Filter
        if (this.state.searchBacklogQuery) {
            const q = this.state.searchBacklogQuery;
            items = items.filter(i =>
                i.title.toLowerCase().includes(q) ||
                i.department.toLowerCase().includes(q)
            );
        }
        if (this.state.filterBacklogDept) {
            items = items.filter(i => i.department === this.state.filterBacklogDept);
        }
        if (this.state.filterBacklogPriority) {
            items = items.filter(i => i.priority === this.state.filterBacklogPriority);
        }
        if (this.state.filterBacklogStatus) {
            items = items.filter(i => i.status === this.state.filterBacklogStatus);
        }

        // 2. Sort
        const { sortBacklogBy, sortBacklogDesc } = this.state;
        items.sort((a, b) => {
            let valA = a[sortBacklogBy];
            let valB = b[sortBacklogBy];

            if (sortBacklogBy === 'priority') {
                valA = this.getPriorityValue(valA);
                valB = this.getPriorityValue(valB);
            } else if (typeof valA === 'string') {
                valA = valA.toLowerCase();
                valB = valB.toLowerCase();
            }

            if (valA < valB) return sortBacklogDesc ? 1 : -1;
            if (valA > valB) return sortBacklogDesc ? -1 : 1;
            return 0;
        });

        // 3. Render
        const tbody = document.querySelector('#backlog-list-table tbody');
        tbody.innerHTML = '';

        items.forEach(item => {
            const tr = document.createElement('tr');

            const priorityBadge =
                item.priority === 'High' ? '<span class="badge badge-red">High</span>' :
                    item.priority === 'Medium' ? '<span class="badge badge-yellow">Medium</span>' :
                        '<span class="badge badge-blue">Low</span>';

            let statusBadgeClass = 'badge-gray';
            if (item.status === 'In Progress') statusBadgeClass = 'badge-blue';
            if (item.status === 'Done') statusBadgeClass = 'badge-green';
            const statusBadge = `<span class="badge ${statusBadgeClass}">${item.status}</span>`;

            const actionsHtml = this.state.isAdmin ? `
                <td style="text-align: center;">
                    <button class="btn btn-ghost btn-sm" onclick="App.editBacklog('${item.id}')" title="編集"><i data-feather="edit-2" width="14"></i></button>
                    <button class="btn btn-ghost btn-sm" onclick="App.deleteBacklog('${item.id}')" title="削除"><i data-feather="trash-2" width="14"></i></button>
                    <button class="btn btn-ghost btn-sm" onclick="App.convertBacklogToRpa('${item.id}')" title="RPA化完了"><i data-feather="check-circle" width="14"></i></button>
                </td>
            ` : '';

            tr.innerHTML = `
                <td style="font-weight: 500;">${item.title}</td>
                <td><span class="badge badge-gray">${item.department}</span></td>
                <td>${priorityBadge}</td>
                <td>${statusBadge}</td>
                <td class="text-right text-main">${item.expectedSavedMinutesPerRun ? (item.expectedSavedMinutesPerRun / 60).toFixed(1) + ' h' : '-'}</td>
                <td class="text-xs text-muted">${item.notes || ''}</td>
                ${actionsHtml}
            `;
            tbody.appendChild(tr);
        });

        feather.replace();
    },

    editBacklog(id) {
        const item = this.data.backlog.find(b => b.id === id);
        if (!item) return;

        document.getElementById('backlog-id').value = item.id;
        document.getElementById('backlog-title').value = item.title;
        document.getElementById('backlog-department').value = item.department;
        document.getElementById('backlog-priority').value = item.priority;
        document.getElementById('backlog-status').value = item.status;
        document.getElementById('backlog-savedHours').value = item.expectedSavedMinutesPerRun ? (item.expectedSavedMinutesPerRun / 60) : '';
        document.getElementById('backlog-notes').value = item.notes || '';

        document.getElementById('backlog-form-container').style.display = 'block';
        document.querySelector('#backlog-form-container h3').scrollIntoView({ behavior: 'smooth' });
    },

    deleteBacklog(id) {
        if (!confirm('本当に削除しますか？')) return;
        this.data.backlog = this.data.backlog.filter(b => b.id !== id);
        this.saveData();
        this.renderBacklogList();
        feather.replace();
    },

    convertBacklogToRpa(id) {
        if (!confirm('このバックログを完了とし、RPA一覧に追加しますか？')) return;

        const backlogItem = this.data.backlog.find(b => b.id === id);
        if (!backlogItem) return;

        // Create new RPA from backlog
        const newRpaId = 'rpa-' + Date.now();
        const now = new Date().toISOString();
        const newRpa = {
            id: newRpaId,
            name: backlogItem.title,
            department: backlogItem.department,
            sheetUrl: '',
            recordingUrl: '',
            devHours: 0,
            tags: [],
            description: backlogItem.notes,
            operationMode: 'manual', // Default
            savedMinutes: backlogItem.expectedSavedMinutesPerRun,
            savedAmount: Math.round(backlogItem.expectedSavedMinutesPerRun / 60 * 1750),
            runCount: 1, // Default to 1 if no run count provided
            createdAt: now,
            updatedAt: now
        };

        this.data.rpas.push(newRpa);

        // Update backlog status to Done
        backlogItem.status = 'Done';

        this.saveData();

        alert('RPA一覧に追加しました！RPA編集画面へ移動します。');
        window.location.hash = `#rpa-edit/${newRpaId}`;
    },

    // --- Quick Links Management ---

    renderQuickLinks() {
        const container = document.getElementById('quick-links-container');
        if (!container) return;
        container.innerHTML = '';

        this.data.quickLinks.forEach(ql => {
            const card = document.createElement('div');
            card.className = 'quick-link-card';
            card.onclick = (e) => {
                if (e.target.closest('.quick-link-actions')) return;
                window.open(ql.url, '_blank');
            };

            const actionsHtml = this.state.isAdmin ? `
                <div class="quick-link-actions">
                    <button onclick="App.editQuickLink('${ql.id}')" title="編集"><i data-feather="edit-2" width="12"></i></button>
                    <button onclick="App.deleteQuickLink('${ql.id}')" title="削除" class="text-red-400"><i data-feather="trash-2" width="12"></i></button>
                </div>
            ` : '';

            card.innerHTML = `
                ${actionsHtml}
                <div class="quick-link-icon-circle">
                    <i data-feather="${ql.icon || 'link'}"></i>
                </div>
                <div class="quick-link-name">${ql.name}</div>
            `;
            container.appendChild(card);
        });
        feather.replace();
    },

    showQuickLinkModal(id = null) {
        this.renderIconOptions();
        const modal = document.getElementById('quick-link-modal');
        const form = document.getElementById('ql-form');
        form.reset();
        document.getElementById('ql-id').value = '';
        document.getElementById('ql-icon').value = 'link';
        document.getElementById('ql-modal-title').textContent = 'クイックリンクの追加';

        if (id) {
            const ql = this.data.quickLinks.find(q => q.id === id);
            if (ql) {
                document.getElementById('ql-id').value = ql.id;
                document.getElementById('ql-name').value = ql.name;
                document.getElementById('ql-url').value = ql.url;
                document.getElementById('ql-icon').value = ql.icon;
                document.getElementById('ql-modal-title').textContent = 'クイックリンクの編集';
                this.selectIcon(ql.icon);
            }
        } else {
            this.selectIcon('link');
        }

        modal.classList.add('active');
    },

    hideQuickLinkModal() {
        document.getElementById('quick-link-modal').classList.remove('active');
    },

    renderIconOptions() {
        const icons = ['calendar', 'file-text', 'external-link', 'link', 'activity', 'database', 'monitor', 'mail', 'users', 'clock', 'check-circle', 'alert-circle', 'settings', 'search', 'folder'];
        const container = document.getElementById('icon-options');
        container.innerHTML = icons.map(icon => `
            <div class="icon-option" data-icon="${icon}" onclick="App.selectIcon('${icon}')">
                <i data-feather="${icon}" width="18"></i>
            </div>
        `).join('');
        feather.replace();
    },

    selectIcon(icon) {
        document.querySelectorAll('.icon-option').forEach(el => {
            el.classList.toggle('selected', el.dataset.icon === icon);
        });
        document.getElementById('ql-icon').value = icon;
    },

    saveQuickLink() {
        const id = document.getElementById('ql-id').value;
        const name = document.getElementById('ql-name').value;
        const url = document.getElementById('ql-url').value;
        const icon = document.getElementById('ql-icon').value;

        if (id) {
            const index = this.data.quickLinks.findIndex(q => q.id === id);
            if (index > -1) {
                this.data.quickLinks[index] = { ...this.data.quickLinks[index], name, url, icon };
            }
        } else {
            this.data.quickLinks.push({
                id: 'ql-' + Date.now(),
                name, url, icon
            });
        }

        this.saveData();
        this.hideQuickLinkModal();
        this.renderQuickLinks();
    },

    editQuickLink(id) {
        this.showQuickLinkModal(id);
    },

    deleteQuickLink(id) {
        if (!confirm('このリンクを削除しますか？')) return;
        this.data.quickLinks = this.data.quickLinks.filter(q => q.id !== id);
        this.saveData();
        this.renderQuickLinks();
    },

    // --- Schedule Engine (空き枠判定・衝突検出) ---

    // 「毎月N日」の曜日が全7曜日を一巡するのに最悪20ヶ月かかる(31日指定)。
    // 1ヶ月だけ見ると「日付指定 × 曜日指定」の衝突を構造的に取りこぼす。
    SCHED_HORIZON_MONTHS: 24,
    WEEKDAY_LABELS: ['日', '月', '火', '水', '木', '金', '土'],

    dateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    addDays(d, n) {
        const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        x.setDate(x.getDate() + n);
        return x;
    },

    todayStart() {
        const n = new Date();
        return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    },

    formatDateJp(d) {
        return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${this.WEEKDAY_LABELS[d.getDay()]})`;
    },

    slotLabel(i) {
        return `${String(Math.floor(i * 30 / 60)).padStart(2, '0')}:${String((i * 30) % 60).padStart(2, '0')}`;
    },

    slotEndLabel(i) {
        return i >= 48 ? '24:00' : this.slotLabel(i);
    },

    normalizeSchedules() {
        (this.data.schedules || []).forEach(s => {
            if (Array.isArray(s.daysOfWeek)) {
                s.daysOfWeek = s.daysOfWeek.map(Number).filter(n => n >= 0 && n <= 6);
            } else if (s.dayOfWeek === '' || s.dayOfWeek === null || s.dayOfWeek === undefined) {
                s.daysOfWeek = [];
            } else {
                s.daysOfWeek = [Number(s.dayOfWeek)];
            }
            if ((s.frequency || 'daily') === 'weekly' && !s.daysOfWeek.length) s.daysOfWeek = [1];
        });
    },

    isScheduleArchived(s) {
        if ((s.frequency || 'daily') !== 'once' || !s.date) return false;
        if (!this._archivedMemo) this._archivedMemo = {};
        if (this._archivedMemo[s.id] === undefined) {
            const end = new Date(`${s.date}T23:59:59`);
            this._archivedMemo[s.id] = !isNaN(end.getTime()) && end < new Date();
        }
        return this._archivedMemo[s.id];
    },

    scheduleActiveOn(s, d) {
        const dow = d.getDay();
        const day = d.getDate();
        const f = s.frequency || 'daily';
        if (f === 'daily') return true;
        if (f === 'weekdays') return dow !== 0 && dow !== 6;
        if (f === 'weekly') return (s.daysOfWeek || []).indexOf(dow) >= 0;
        if (f === 'monthly') return Number(s.dayOfMonth) === day;
        if (f === 'end_of_month') return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === day;
        if (f === 'once') return s.date === this.dateKey(d);
        return false;
    },

    scheduleFreqLabel(s) {
        const f = s.frequency || 'daily';
        if (f === 'weekly') return '毎週' + (s.daysOfWeek || []).map(i => this.WEEKDAY_LABELS[i]).join('・') + '曜';
        if (f === 'monthly') return `毎月${s.dayOfMonth}日`;
        if (f === 'once') return `単発予約 ${this.escapeHtml(s.date)}`;
        return { daily: '毎日', weekdays: '平日のみ', end_of_month: '毎月月末' }[f] || '毎日';
    },

    // 終了 <= 開始 の予定は翌日へ繰り越して占有させる
    buildOccupancy(terminalId, from, nDays) {
        if (!this._occCache) this._occCache = {};
        const ck = `${terminalId}|${this.dateKey(from)}|${nDays}`;
        if (this._occCache[ck]) return this._occCache[ck];

        const idx = {};
        for (let i = -1; i <= nDays + 1; i++) idx[this.dateKey(this.addDays(from, i))] = [];
        const list = (this.data.schedules || []).filter(s => s.terminalId === terminalId && !this.isScheduleArchived(s));
        for (let i = -1; i <= nDays; i++) {
            const d = this.addDays(from, i);
            const k = this.dateKey(d);
            list.forEach(s => {
                if (!this.scheduleActiveOn(s, d)) return;
                const a = this.timeToMinutes(s.startTime);
                const b = this.timeToMinutes(s.endTime);
                if (b > a) {
                    idx[k].push({ s, a, b });
                    return;
                }
                idx[k].push({ s, a, b: 1440 });
                const nk = this.dateKey(this.addDays(d, 1));
                if (idx[nk] && b > 0) idx[nk].push({ s, a: 0, b, over: true });
            });
        }
        this._occCache[ck] = idx;
        return idx;
    },

    slotHits(occ, k, i) {
        return (occ[k] || []).filter(x => x.a < (i + 1) * 30 && x.b > i * 30);
    },

    // 1日ぶんの占有を48コマへ一度だけ展開する（コマごとに全件走査すると1画面で数万回になる）
    slotMap(occ, k) {
        const map = new Array(48).fill(null);
        (occ[k] || []).forEach(x => {
            const from = Math.max(0, Math.floor(x.a / 30));
            const to = Math.min(48, Math.ceil(x.b / 30));
            for (let i = from; i < to; i++) {
                if (!map[i]) map[i] = [];
                map[i].push(x);
            }
        });
        return map;
    },

    condTargetsDay(cond, d) {
        const dow = d.getDay();
        const day = d.getDate();
        if (cond.freq === 'daily') return true;
        if (cond.freq === 'weekdays') return dow !== 0 && dow !== 6;
        if (cond.freq === 'weekly') return (cond.dows || []).indexOf(dow) >= 0;
        if (cond.freq === 'monthly') return Number(cond.dom) === day;
        if (cond.freq === 'end_of_month') return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === day;
        if (cond.freq === 'once') return cond.date === this.dateKey(d);
        return true;
    },

    horizonRange() {
        const from = this.todayStart();
        const to = new Date(from.getFullYear(), from.getMonth() + this.SCHED_HORIZON_MONTHS, from.getDate());
        return { from, nDays: Math.round((to - from) / 86400000) };
    },

    scheduleStats(terminalId, year, month, cond) {
        const days = new Date(year, month + 1, 0).getDate();
        const monthOcc = this.buildOccupancy(terminalId, new Date(year, month, 1), days);
        const monthStat = Array.from({ length: 48 }, () => ({ tgt: 0, busy: 0, hits: [] }));
        for (let dd = 1; dd <= days; dd++) {
            const d = new Date(year, month, dd);
            if (!this.condTargetsDay(cond, d)) continue;
            const map = this.slotMap(monthOcc, this.dateKey(d));
            for (let i = 0; i < 48; i++) {
                monthStat[i].tgt++;
                const hits = map[i];
                if (!hits) continue;
                monthStat[i].busy++;
                hits.forEach(x => monthStat[i].hits.push({ d, s: x.s, over: x.over }));
            }
        }

        const { from, nDays } = this.horizonRange();
        const horOcc = this.buildOccupancy(terminalId, from, nDays);
        const horStat = Array.from({ length: 48 }, () => ({ tgt: 0, busy: 0, first: null, who: new Map() }));
        for (let i = 0; i <= nDays; i++) {
            const d = this.addDays(from, i);
            if (!this.condTargetsDay(cond, d)) continue;
            const map = this.slotMap(horOcc, this.dateKey(d));
            for (let j = 0; j < 48; j++) {
                horStat[j].tgt++;
                const hits = map[j];
                if (!hits) continue;
                horStat[j].busy++;
                if (!horStat[j].first) horStat[j].first = d;
                hits.forEach(x => {
                    if (!horStat[j].who.has(x.s.id)) horStat[j].who.set(x.s.id, { s: x.s, first: d });
                });
            }
        }
        return { month: monthStat, horizon: horStat, occ: monthOcc, days };
    },

    freeRanges(stat, minMinutes) {
        const out = [];
        let start = null;
        for (let i = 0; i < 48; i++) {
            const free = stat[i].tgt > 0 && stat[i].busy === 0;
            if (free) {
                if (start === null) start = i;
            } else if (start !== null) {
                out.push([start, i]);
                start = null;
            }
        }
        if (start !== null) out.push([start, 48]);
        return out.filter(r => (r[1] - r[0]) * 30 >= Number(minMinutes));
    },

    scanScheduleConflicts() {
        const { from, nDays } = this.horizonRange();
        const out = [];
        (this.data.terminals || []).forEach(t => {
            const occ = this.buildOccupancy(t.id, from, nDays);
            const acc = new Map();
            for (let i = 0; i <= nDays; i++) {
                const d = this.addDays(from, i);
                const items = occ[this.dateKey(d)] || [];
                for (let a = 0; a < items.length; a++) {
                    for (let b = a + 1; b < items.length; b++) {
                        const X = items[a];
                        const Y = items[b];
                        if (X.s.id === Y.s.id) continue;
                        if (!(X.a < Y.b && X.b > Y.a)) continue;
                        const pk = [X.s.id, Y.s.id].sort().join('|');
                        if (!acc.has(pk)) acc.set(pk, { terminal: t, a: X.s, b: Y.s, first: d, count: 0 });
                        acc.get(pk).count++;
                    }
                }
            }
            acc.forEach(v => out.push(v));
        });
        return out.sort((x, y) => x.first - y.first);
    },

    findScheduleConflicts(terminalId, startTime, endTime, cond, excludeId) {
        const { from, nDays } = this.horizonRange();
        const occ = this.buildOccupancy(terminalId, from, nDays);
        const a = this.timeToMinutes(startTime);
        const b = this.timeToMinutes(endTime);
        const overnight = b <= a;
        const found = new Map();
        for (let i = 0; i <= nDays; i++) {
            const d = this.addDays(from, i);
            if (!this.condTargetsDay(cond, d)) continue;
            const dk = this.dateKey(d);
            const segs = overnight
                ? [[dk, a, 1440, false], [this.dateKey(this.addDays(d, 1)), 0, b, true]]
                : [[dk, a, b, false]];
            segs.forEach(seg => {
                const [k, x, y, isNextDay] = seg;
                if (y <= x) return;
                // 繰り越し分の衝突は「翌日側の日付」で報告する（開始日で出すと平日判定と食い違って見える）
                const hitDate = isNextDay ? this.addDays(d, 1) : d;
                (occ[k] || []).forEach(o => {
                    if (o.s.id === excludeId) return;
                    if (!(o.a < y && o.b > x)) return;
                    if (!found.has(o.s.id)) found.set(o.s.id, { s: o.s, first: hitDate, count: 0, nextDay: isNextDay });
                    found.get(o.s.id).count++;
                });
            });
        }
        return [...found.values()].sort((x, y) => x.first - y.first);
    },

    // --- Schedule Timeline (Gantt) ---

    renderSchedule() {
        if(!this.data.terminals || !this.data.schedules) return;

        // Date selection
        const dateInput = document.getElementById('schedule-date-filter');
        if (!dateInput.value) {
            // YYYY-MM-DD local timezone
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            dateInput.value = `${year}-${month}-${day}`;
        }
        
        const selectedDate = new Date(dateInput.value);
        const targetDate = selectedDate;

        // 1. ヘッダーの描画 (0:00 - 23:00)
        const headersHtml = Array.from({length: 24}, (_, i) => `<div class="time-header-slot">${i}:00</div>`).join('');
        document.getElementById('timeline-headers').innerHTML = headersHtml;

        // 2. 端末リストとタイムライン行の描画
        let terminalsHtml = '';
        let rowsHtml = '';

        const timelineDayKey = this.dateKey(targetDate);

        this.data.terminals.forEach(terminal => {
            terminalsHtml += `<div class="schedule-cell row-header"><span style="display:inline-block; width:10px; height:10px; border-radius:2px; background-color:${terminal.color || '#3b82f6'}; margin-right:6px;"></span> ${terminal.name}</div>`;

            const occ = this.buildOccupancy(terminal.id, targetDate, 0);
            const termSchedules = (occ[timelineDayKey] || []).slice().sort((a, b) => a.a - b.a);

            let blocksHtml = '';

            termSchedules.forEach(item => {
                const sch = item.s;
                const rpa = this.data.rpas.find(r => r.id === sch.rpaId);
                if(!rpa) return;

                const startMins = item.a;
                const endMins = item.b;
                const widthPx = Math.max(endMins - startMins, 15); // 最低15px幅を確保

                // ステータス判定 (最新のrunsから取得)
                const runModes = this.data.runs.filter(r => r.scheduleId === sch.id).sort((a,b) => new Date(b.executedAt) - new Date(a.executedAt));
                const latestRun = runModes.length > 0 ? runModes[0] : null;
                
                let statusDotHtml = '';
                if(latestRun) {
                    if(latestRun.status === 'success') statusDotHtml = '<span class="bg-success" style="width:6px; height:6px; display:inline-block; border-radius:50%; margin-right:4px; box-shadow: 0 0 2px rgba(0,0,0,0.5);"></span>';
                    if(latestRun.status === 'error') statusDotHtml = '<span class="bg-danger" style="width:6px; height:6px; display:inline-block; border-radius:50%; margin-right:4px; box-shadow: 0 0 2px rgba(0,0,0,0.5);"></span>';
                    if(latestRun.status === 'running') statusDotHtml = '<span class="bg-primary" style="width:6px; height:6px; display:inline-block; border-radius:50%; margin-right:4px; box-shadow: 0 0 2px rgba(0,0,0,0.5);"></span>';
                }

                let iconName = sch.frequency === 'daily' ? 'refresh-cw' : 'calendar';
                // Only allow click if admin
                const clickEvent = this.state.isAdmin ? `onclick="App.showScheduleModal('${sch.id}')"` : '';
                const cursorStyle = this.state.isAdmin ? 'cursor: pointer;' : 'cursor: default;';

                const tColor = terminal.color || '#3b82f6';
                const bgRgba = this.hexToRgba(tColor, 0.2);
                const overMark = item.over ? '前日から継続 / ' : (endMins === 1440 && this.timeToMinutes(sch.endTime) <= this.timeToMinutes(sch.startTime) ? '翌日へ継続 / ' : '');

                blocksHtml += `
                    <div class="schedule-block" style="left: ${startMins}px; width: ${widthPx}px; border-left: 3px solid ${tColor}; background-color: ${bgRgba}; ${cursorStyle}" title="${rpa.name}\n${overMark}${sch.startTime} - ${sch.endTime}" ${clickEvent}>
                        <div class="truncate flex items-center" style="font-size: 11px; margin-bottom: 2px;">${statusDotHtml}<i data-feather="${iconName}" style="width:10px; height:10px; margin-right:4px;"></i> ${rpa.name}</div>
                        <div style="font-size: 9px; opacity: 0.8;">${overMark}${sch.startTime} - ${sch.endTime}</div>
                    </div>
                `;
            });

            rowsHtml += `<div class="timeline-row">${blocksHtml}</div>`;
        });

        document.getElementById('schedule-terminal-list').innerHTML = terminalsHtml;
        document.getElementById('timeline-rows').innerHTML = rowsHtml;

        // 3. 現在時刻バーの更新
        this.updateCurrentTimeLine();
        if (this.timelineInterval) clearInterval(this.timelineInterval);
        this.timelineInterval = setInterval(() => this.updateCurrentTimeLine(), 60000); // 1分ごとに更新
        
        // 4. スクロール同期 (縦スクロール時に端末リストも動かす)
        const wrapper = document.getElementById('timeline-wrapper');
        const sidebarList = document.getElementById('schedule-terminal-list');
        // リスナーの重複登録を避けるため、一度削除またはクローン
        const newWrapper = wrapper.cloneNode(true);
        wrapper.parentNode.replaceChild(newWrapper, wrapper);
        
        newWrapper.addEventListener('scroll', () => {
            sidebarList.style.transform = `translateY(-${newWrapper.scrollTop}px)`;
        });

        // setTimeout is needed because cloning the node resets the scroll position
        setTimeout(() => {
           if (window.feather) feather.replace();
        }, 0);
        
        // Populate List View and Calendar View
        this.renderScheduleList();
        this.renderCalendar();
        this.renderFreeSlots();
        this.renderScheduleAlerts();
    },

    changeScheduleDate(offset) {
        const input = document.getElementById('schedule-date-filter');
        if (!input) return;
        
        let currentDate = input.value ? new Date(input.value) : new Date();
        currentDate.setDate(currentDate.getDate() + offset);
        
        const year = currentDate.getFullYear();
        const month = String(currentDate.getMonth() + 1).padStart(2, '0');
        const day = String(currentDate.getDate()).padStart(2, '0');
        
        input.value = `${year}-${month}-${day}`;
        this.renderSchedule();
    },

    resetScheduleDate() {
        const input = document.getElementById('schedule-date-filter');
        if (!input) return;
        
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        
        input.value = `${year}-${month}-${day}`;
        this.renderSchedule();
    },

    changeCalendarMonth(delta) {
        this.state.calendarDate.setMonth(this.state.calendarDate.getMonth() + delta);
        this.renderCalendar();
    },

    resetCalendarMonth() {
        this.state.calendarDate = new Date();
        this.renderCalendar();
    },

    renderCalendar() {
        const grid = document.getElementById('calendar-grid');
        const title = document.getElementById('calendar-month-title');
        if (!grid || !title) return;

        const year = this.state.calendarDate.getFullYear();
        const month = this.state.calendarDate.getMonth();
        
        title.textContent = `${year}年${month + 1}月`;

        // Generate headers
        const daysOfWeek = ['日', '月', '火', '水', '木', '金', '土'];
        const dayColors = ['color:#f87171;', '', '', '', '', '', 'color:#60a5fa;'];
        let html = daysOfWeek.map((d, i) => `<div class="calendar-header-cell" style="${dayColors[i]}">${d}</div>`).join('');

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        
        const startPadding = firstDay.getDay(); // 0(Sun) - 6(Sat)
        const totalDays = lastDay.getDate();
        
        // previous month padding
        const prevMonthLastDay = new Date(year, month, 0).getDate();
        for(let i = startPadding - 1; i >= 0; i--) {
            html += `<div class="calendar-cell other-month"><div class="calendar-date-label">${prevMonthLastDay - i}</div></div>`;
        }

        const today = new Date();
        const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

        for(let day = 1; day <= totalDays; day++) {
            const currentDate = new Date(year, month, day);
            const dayOfWeek = currentDate.getDay();
            
            const isToday = isCurrentMonth && day === today.getDate();
            let cls = `calendar-cell ${isToday ? 'today' : ''}`;
            
            // Find schedules for this day
            const daySchedules = this.data.schedules.filter(s =>
                !this.isScheduleArchived(s) && this.scheduleActiveOn(s, currentDate));

            // Sort by time
            daySchedules.sort((a,b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));

            let eventsHtml = daySchedules.map(sch => {
                const rpa = this.data.rpas.find(r => r.id === sch.rpaId);
                const term = this.data.terminals.find(t => t.id === sch.terminalId);
                if (!rpa) return '';
                
                const tColor = term?.color || '#3b82f6';
                let bgStyle = `background: ${this.hexToRgba(tColor, 0.7)};`;

                // Status background based on last run (optional visual enhancement)
                const runModes = this.data.runs.filter(r => r.scheduleId === sch.id).sort((a,b) => new Date(b.executedAt) - new Date(a.executedAt));
                const latestRun = runModes.length > 0 ? runModes[0] : null;
                
                let statusDotHtml = '';
                if(latestRun) {
                    if(latestRun.status === 'success') statusDotHtml = '<span class="bg-success" style="width:6px; height:6px; display:inline-block; border-radius:50%; margin-right:2px; box-shadow: 0 0 2px rgba(0,0,0,0.5);"></span>';
                    if(latestRun.status === 'error') statusDotHtml = '<span class="bg-danger" style="width:6px; height:6px; display:inline-block; border-radius:50%; margin-right:2px; box-shadow: 0 0 2px rgba(0,0,0,0.5);"></span>';
                    if(latestRun.status === 'running') statusDotHtml = '<span class="bg-primary" style="width:6px; height:6px; display:inline-block; border-radius:50%; margin-right:2px; box-shadow: 0 0 2px rgba(0,0,0,0.5);"></span>';
                }

                let iconName = (sch.frequency === 'daily' || sch.frequency === 'weekdays') ? 'refresh-cw' : 'calendar';
                const clickEvent = this.state.isAdmin ? `onclick="App.showScheduleModal('${sch.id}')"` : '';
                return `
                    <div class="calendar-event" style="${bgStyle}" title="${rpa.name} (${term?.name || '端末未定'})\n${sch.startTime}-${sch.endTime}" ${clickEvent}>
                        ${statusDotHtml}
                        <i data-feather="${iconName}" style="width:10px; height:10px; flex-shrink:0;"></i>
                        <span class="truncate ml-1">${sch.startTime} ${rpa.name}</span>
                    </div>
                `;
            }).join('');

            const dateLabelStyle = dayOfWeek === 0 ? 'color:#f87171;' : dayOfWeek === 6 ? 'color:#60a5fa;' : '';
            html += `<div class="${cls}">
                <div class="calendar-date-label" style="${dateLabelStyle}">${day}</div>
                ${eventsHtml}
            </div>`;
        }

        // next month padding to complete the grid
        const totalCells = startPadding + totalDays;
        const totalRows = Math.ceil(totalCells / 7);
        const endPadding = (totalRows * 7) - totalCells;
        for(let i = 1; i <= endPadding; i++) {
            html += `<div class="calendar-cell other-month"><div class="calendar-date-label">${i}</div></div>`;
        }

        grid.innerHTML = html;
        if (window.feather) feather.replace();
    },

    renderScheduleList() {
        const tbody = document.getElementById('schedule-list-body');
        if (!tbody) return;

        const freqLabels = {
            'daily': '<span class="px-2 py-1 rounded bg-slate-700 text-xs">毎日</span>',
            'weekdays': '<span class="px-2 py-1 rounded bg-slate-700 text-xs text-green-300">平日のみ</span>',
            'weekly': '<span class="px-2 py-1 rounded bg-slate-700 text-xs text-blue-300">曜日指定</span>',
            'monthly': '<span class="px-2 py-1 rounded bg-slate-700 text-xs text-purple-300">日付指定</span>',
            'end_of_month': '<span class="px-2 py-1 rounded bg-slate-700 text-xs text-orange-300">月末</span>',
            'once': '<span class="px-2 py-1 rounded bg-slate-700 text-xs text-yellow-300">単発予約</span>'
        };

        const rowHtml = (sch) => {
            const rpa = this.data.rpas.find(r => r.id === sch.rpaId);
            const term = this.data.terminals.find(t => t.id === sch.terminalId);
            const rpaName = rpa ? rpa.name : '<span class="text-red-400">不明なRPA</span>';
            const termName = term ? term.name : '<span class="text-red-400">不明な端末</span>';

            let freqDetail = freqLabels[sch.frequency || 'daily'];
            if (sch.frequency === 'weekly') freqDetail += `<span class="sched-hint-inline">(${(sch.daysOfWeek || []).map(i => this.WEEKDAY_LABELS[i]).join('・')}曜)</span>`;
            if (sch.frequency === 'monthly') freqDetail += `<span class="sched-hint-inline">(${sch.dayOfMonth}日)</span>`;
            if (sch.frequency === 'once') freqDetail += `<span class="sched-hint-inline">(${sch.date})</span>`;

            const overnight = this.timeToMinutes(sch.endTime) <= this.timeToMinutes(sch.startTime);
            const endLabel = overnight ? `${sch.endTime}<span class="sched-hint-inline">翌日</span>` : sch.endTime;

            const adminAction = this.state.isAdmin ?
                `<button class="btn btn-ghost btn-sm text-primary" onclick="App.showScheduleModal('${sch.id}')"><i data-feather="edit-2" width="14"></i> 編集</button>` :
                '-';

            return `
                <tr>
                    <td class="font-bold">${rpaName}</td>
                    <td>${termName}</td>
                    <td>${freqDetail}</td>
                    <td>${sch.startTime}</td>
                    <td>${endLabel}</td>
                    ${this.state.isAdmin ? `<td class="text-right">${adminAction}</td>` : ''}
                </tr>
            `;
        };

        const active = this.data.schedules.filter(s => !this.isScheduleArchived(s));
        const archived = this.data.schedules.filter(s => this.isScheduleArchived(s));
        tbody.innerHTML = active.map(rowHtml).join('');

        const archiveBox = document.getElementById('schedule-archive');
        if (archiveBox) {
            archiveBox.innerHTML = archived.length ? `
                <div class="sched-alert note">
                    <div class="hd"><i data-feather="archive" width="14"></i> 終了した単発予約 ${archived.length}件（枠は解放済み・空き枠判定と衝突判定から除外）</div>
                    <ul>${archived.map(s => {
                        const rpa = this.data.rpas.find(r => r.id === s.rpaId);
                        const term = this.data.terminals.find(t => t.id === s.terminalId);
                        const del = this.state.isAdmin ? ` <button class="btn btn-ghost btn-sm text-primary" onclick="App.showScheduleModal('${s.id}')">開く</button>` : '';
                        return `<li>・${this.escapeHtml(rpa ? rpa.name : '不明なRPA')} ${this.escapeHtml(s.date)} ${s.startTime}–${s.endTime}（${this.escapeHtml(term ? term.name : '不明な端末')}）${del}</li>`;
                    }).join('')}</ul>
                </div>` : '';
        }
        
        // Admin header column sync
        const headRow = document.querySelector('#schedule-list-table thead tr');
        if (headRow) {
            const hasActionCol = headRow.lastElementChild.textContent === '操作';
            if (this.state.isAdmin && !hasActionCol) {
                headRow.insertAdjacentHTML('beforeend', '<th class="text-right">操作</th>');
            } else if (!this.state.isAdmin && hasActionCol) {
                headRow.lastElementChild.remove();
            }
        }

        if (window.feather) feather.replace();
    },

    // --- Free Slot Finder ---

    freeCondLabel() {
        const c = this.state.freeCond;
        if (c.freq === 'weekly') return c.dows.map(i => this.WEEKDAY_LABELS[i]).join('・') + '曜';
        if (c.freq === 'monthly') return `${c.dom}日`;
        return { daily: '毎日', weekdays: '平日のみ' }[c.freq] || '毎日';
    },

    setFreeTerminal(id) {
        this.state.freeTerminal = id;
        this.renderFreeSlots();
    },

    setFreeFreq(freq) {
        this.state.freeCond.freq = freq;
        this.renderFreeSlots();
    },

    toggleFreeDow(i) {
        const cur = this.state.freeCond.dows;
        const next = cur.indexOf(i) >= 0 ? cur.filter(x => x !== i) : cur.concat(i);
        this.state.freeCond.dows = next.length ? next.sort((a, b) => a - b) : [i];
        this.renderFreeSlots();
    },

    changeFreeMonth(delta) {
        const d = new Date(this.state.freeMonth.getFullYear(), this.state.freeMonth.getMonth() + delta, 1);
        this.state.freeMonth = d;
        this.renderFreeSlots();
    },

    resetFreeMonth() {
        this.state.freeMonth = new Date();
        this.renderFreeSlots();
    },

    renderFreeSlots() {
        const grid = document.getElementById('free-heatmap');
        if (!grid) return;
        const terminals = this.data.terminals || [];
        if (!terminals.length) {
            grid.innerHTML = '';
            document.getElementById('free-chips').innerHTML = '<div class="free-none">端末が登録されていません。</div>';
            return;
        }
        if (!this.state.freeTerminal || !terminals.some(t => t.id === this.state.freeTerminal)) {
            this.state.freeTerminal = terminals[0].id;
        }

        const cond = this.state.freeCond;
        const term = terminals.find(t => t.id === this.state.freeTerminal);
        const year = this.state.freeMonth.getFullYear();
        const month = this.state.freeMonth.getMonth();

        document.getElementById('free-month-title').textContent = `${year}年${month + 1}月`;
        document.getElementById('free-terminals').innerHTML = terminals.map(t =>
            `<button class="${t.id === term.id ? 'active' : ''}" onclick="App.setFreeTerminal('${t.id}')"><span class="term-dot" style="background:${t.color || '#3b82f6'}"></span>${this.escapeHtml(t.name)}</button>`).join('');
        document.querySelectorAll('#free-freq button').forEach(b => b.classList.toggle('active', b.dataset.f === cond.freq));
        document.getElementById('free-dow').style.display = cond.freq === 'weekly' ? '' : 'none';
        document.getElementById('free-dom').style.display = cond.freq === 'monthly' ? '' : 'none';
        document.getElementById('free-dow').innerHTML = this.WEEKDAY_LABELS.map((w, i) => {
            const on = cond.dows.indexOf(i) >= 0 ? ' active' : '';
            const tone = i === 0 ? ' sun' : i === 6 ? ' sat' : '';
            return `<button type="button" class="${tone}${on}" onclick="App.toggleFreeDow(${i})">${w}</button>`;
        }).join('');

        const stats = this.scheduleStats(term.id, year, month, cond);
        this._freeStats = { stats, year, month, termId: term.id };

        const dur = this.state.freeDur;
        const good = this.freeRanges(stats.horizon, dur);
        document.getElementById('free-sum-head').textContent =
            `${term.name} ／ ${this.freeCondLabel()} ／ ${dur}分以上 → ${this.SCHED_HORIZON_MONTHS}ヶ月ずっと空いている枠`;
        document.getElementById('free-chips').innerHTML = good.length
            ? good.map(r => `<div class="free-chip"${this.state.isAdmin ? ` onclick="App.useFreeSlot('${term.id}','${this.slotLabel(r[0])}','${this.slotEndLabel(r[1])}')"` : ' style="cursor:default"'}><i data-feather="check" width="12"></i>${this.slotLabel(r[0])} – ${this.slotEndLabel(r[1])}<span class="len">${(r[1] - r[0]) * 30}分</span></div>`).join('')
            : `<div class="free-none"><i data-feather="alert-triangle" width="14"></i>この条件で${this.SCHED_HORIZON_MONTHS}ヶ月ずっと空いている枠はありません。所要時間を短くするか、他の端末を確認してください。</div>`;

        const traps = [];
        for (let i = 0; i < 48; i++) {
            if (stats.month[i].tgt > 0 && stats.month[i].busy === 0 && stats.horizon[i].busy > 0) traps.push(i);
        }
        const noteBox = document.getElementById('free-note');
        if (stats.month[0].tgt === 0) {
            // 「31日」を選んで30日以下の月を表示した場合など
            noteBox.innerHTML = `この月に該当日はありません（下のグリッドは参考表示です）。上の緑の枠は${this.SCHED_HORIZON_MONTHS}ヶ月ぶんで判定しているのでそのまま使えます。`;
        } else {
            noteBox.innerHTML = traps.length
                ? `対象日 ${stats.month[0].tgt}日／月　<span class="trap-text">この月は空きに見えるのに将来ふさがる時間帯が ${traps.length} コマ（30分単位）</span>：最も早いのは ${this.slotLabel(traps[0])}〜 の ${this.formatDateJp(stats.horizon[traps[0]].first)}`
                : `対象日 ${stats.month[0].tgt}日／月　この月の空きと${this.SCHED_HORIZON_MONTHS}ヶ月の空きは一致しています。`;
        }

        let html = '<thead><tr><th class="hm-rowlab"></th>';
        for (let i = 0; i < 48; i++) html += `<th class="hm-hcol ${i % 2 === 0 ? 'hm-hour' : ''}">${i % 2 === 0 ? i / 2 : ''}</th>`;
        html += `</tr><tr><td class="hm-sumlab">${this.SCHED_HORIZON_MONTHS}ヶ月<br>まとめ</td>`;
        for (let i = 0; i < 48; i++) {
            const o = stats.horizon[i];
            const cls = o.tgt === 0 ? '' : o.busy === 0 ? 'free' : o.busy === o.tgt ? 'busy' : 'part';
            html += `<td class="hm-sumcell ${cls} ${i % 2 === 0 ? 'hm-hour' : ''}" data-i="${i}" data-r="h" onmouseenter="App.showFreeDetail(this)"></td>`;
        }
        html += '</tr><tr><td class="hm-sumlab">この月<br>まとめ</td>';
        for (let i = 0; i < 48; i++) {
            const o = stats.month[i];
            let cls = o.tgt === 0 ? '' : o.busy === 0 ? 'free' : o.busy === o.tgt ? 'busy' : 'part';
            if (cls === 'free' && stats.horizon[i].busy > 0) cls = 'trap';
            html += `<td class="hm-sumcell ${cls} ${i % 2 === 0 ? 'hm-hour' : ''}" data-i="${i}" data-r="m" onmouseenter="App.showFreeDetail(this)"></td>`;
        }
        html += '</tr></thead><tbody>';

        const todayKey = this.dateKey(new Date());
        const tColor = term.color || '#3b82f6';
        for (let dd = 1; dd <= stats.days; dd++) {
            const d = new Date(year, month, dd);
            const dw = d.getDay();
            const isTarget = this.condTargetsDay(cond, d);
            const isToday = this.dateKey(d) === todayKey;
            const tone = dw === 0 ? 'sun' : dw === 6 ? 'sat' : '';
            html += `<tr class="${isTarget ? '' : 'hm-off'}"><td class="hm-rowlab ${tone} ${isToday ? 'today' : ''}">${month + 1}/${dd}(${this.WEEKDAY_LABELS[dw]})</td>`;
            const map = this.slotMap(stats.occ, this.dateKey(d));
            for (let i = 0; i < 48; i++) {
                const hits = map[i];
                const style = hits ? ` style="--hm-bc:${this.hexToRgba(tColor, Math.min(0.3 + hits.length * 0.3, 0.95))}"` : '';
                html += `<td class="hm-cell ${hits ? 'busy' : ''} ${i % 2 === 0 ? 'hm-hour' : ''}" data-d="${dd}" data-i="${i}"${style} onmouseenter="App.showFreeDetail(this)"></td>`;
            }
            html += '</tr>';
        }
        grid.innerHTML = html + '</tbody>';

        this.renderFreeCandidates();
        document.getElementById('free-detail').innerHTML = '<div class="k">セル詳細</div><span class="sched-hint">グリッドやサマリ帯にマウスを当てると内訳が出ます。</span>';
        feather.replace();
    },

    showFreeDetail(cell) {
        const box = document.getElementById('free-detail');
        if (!box || !this._freeStats) return;
        const { stats, year, month } = this._freeStats;
        const i = Number(cell.dataset.i);
        const label = `${this.slotLabel(i)} – ${this.slotEndLabel(i + 1)}`;

        if (cell.dataset.d) {
            const d = new Date(year, month, Number(cell.dataset.d));
            const hits = this.slotHits(stats.occ, this.dateKey(d), i);
            box.innerHTML = `<div class="k">${this.formatDateJp(d)} ${label}</div>` + (hits.length
                ? hits.map(x => `<div class="hit"><strong>${this.rpaNameOf(x.s.rpaId)}</strong><span class="meta">${x.s.startTime}–${x.s.endTime} ／ ${this.scheduleFreqLabel(x.s)}</span>${x.over ? '<span class="meta">前日から日跨ぎ</span>' : ''}</div>`).join('')
                : '<span class="sched-hint">空き</span>');
            return;
        }

        if (cell.dataset.r === 'h') {
            const o = stats.horizon[i];
            const who = [...o.who.values()].sort((a, b) => a.first - b.first);
            box.innerHTML = `<div class="k">${label} ／ ${this.SCHED_HORIZON_MONTHS}ヶ月判定：対象 ${o.tgt}日中 ${o.tgt - o.busy}日 空き</div>` + (who.length
                ? who.slice(0, 12).map(v => `<div class="hit"><span class="d">初回 ${this.formatDateJp(v.first)}</span><strong>${this.rpaNameOf(v.s.rpaId)}</strong><span class="meta">${v.s.startTime}–${v.s.endTime} ／ ${this.scheduleFreqLabel(v.s)}</span></div>`).join('')
                : `<span class="sched-hint">${this.SCHED_HORIZON_MONTHS}ヶ月ずっと空いています。安心して登録できます。</span>`);
            return;
        }

        const o = stats.month[i];
        const hz = stats.horizon[i];
        let head = `<div class="k">${label} ／ この月：対象 ${o.tgt}日中 ${o.tgt - o.busy}日 空き</div>`;
        if (o.busy === 0 && hz.busy > 0) {
            const who = [...hz.who.values()].sort((a, b) => a.first - b.first);
            box.innerHTML = head + `<div class="sched-alert future"><div class="hd"><i data-feather="alert-triangle" width="14"></i> この月は空きですが、将来ふさがります</div>` +
                who.map(v => `<div>・${this.formatDateJp(v.first)} から <strong>${this.rpaNameOf(v.s.rpaId)}</strong>（${this.scheduleFreqLabel(v.s)} ${v.s.startTime}–${v.s.endTime}）</div>`).join('') + '</div>';
            feather.replace();
            return;
        }
        const uniq = [...new Map(o.hits.map(x => [x.s.id + this.dateKey(x.d), x])).values()];
        box.innerHTML = head + (uniq.length
            ? uniq.slice(0, 12).map(x => `<div class="hit"><span class="d">${x.d.getMonth() + 1}/${x.d.getDate()}</span><strong>${this.rpaNameOf(x.s.rpaId)}</strong><span class="meta">${x.s.startTime}–${x.s.endTime}</span></div>`).join('')
            : '<span class="sched-hint">この月は空いています。</span>');
    },

    renderFreeCandidates() {
        const box = document.getElementById('free-cands');
        if (!box) return;
        const cond = this.state.freeCond;
        const dur = Number(this.state.freeDur);
        const year = this.state.freeMonth.getFullYear();
        const month = this.state.freeMonth.getMonth();
        const targets = this.state.freeAllTerminals
            ? (this.data.terminals || [])
            : (this.data.terminals || []).filter(t => t.id === this.state.freeTerminal);

        const out = [];
        targets.forEach(t => {
            const st = this.scheduleStats(t.id, year, month, cond);
            this.freeRanges(st.horizon, dur).forEach(r => out.push({ t, a: r[0], b: r[1], len: (r[1] - r[0]) * 30 }));
        });
        out.sort((x, y) => y.len - x.len);

        box.innerHTML = out.length ? out.map((o, i) => `
            <div class="free-cand ${i === 0 ? 'best' : ''}">
                <div class="cand-term"><span class="term-dot" style="background:${o.t.color || '#3b82f6'}"></span>${this.escapeHtml(o.t.name)}${i === 0 ? '（最有力）' : ''}</div>
                <div class="cand-time">${this.slotLabel(o.a)} – ${this.slotEndLabel(o.b)}</div>
                <div class="cand-meta">連続${o.len}分 ／ 必要${dur}分に対し余裕${o.len - dur}分</div>
                ${this.state.isAdmin ? `<button class="btn btn-primary btn-sm" onclick="App.useFreeSlot('${o.t.id}','${this.slotLabel(o.a)}','${this.slotEndLabel(o.b)}')"><i data-feather="plus" width="12"></i> この枠で登録</button>` : ''}
            </div>`).join('') : '<div class="free-none">条件に合う枠がありません。</div>';
        feather.replace();
    },

    useFreeSlot(terminalId, start, end) {
        if (!this.state.isAdmin) {
            alert('スケジュールの登録は管理者ログインが必要です。');
            return;
        }
        this.showScheduleModal();
        document.getElementById('sch-terminal').value = terminalId;
        document.getElementById('sch-start').value = start;
        document.getElementById('sch-end').value = end === '24:00' ? '23:59' : end;
        document.getElementById('sch-frequency').value = this.state.freeCond.freq;
        this.state.modalDows = this.state.freeCond.dows.slice();
        if (this.state.freeCond.freq === 'monthly') {
            document.getElementById('sch-day-of-month').value = this.state.freeCond.dom;
        }
        this.renderModalDowPicker();
        document.getElementById('sch-frequency').dispatchEvent(new Event('change'));
    },

    // --- Conflict Alerts ---

    renderScheduleAlerts() {
        const nowBox = document.getElementById('alerts-now');
        const futureBox = document.getElementById('alerts-future');
        const badge = document.getElementById('alert-badge');
        if (!nowBox || !futureBox) return;

        const conflicts = this.scanScheduleConflicts();
        const monthEnd = new Date();
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        const now = conflicts.filter(c => c.first <= monthEnd);
        const future = conflicts.filter(c => c.first > monthEnd);

        if (badge) {
            badge.textContent = conflicts.length;
            badge.style.display = conflicts.length ? '' : 'none';
        }

        const table = (rows, tone) => `
            <div class="conflict-table">
                <div class="conflict-row head"><span>初回</span><span>予定A</span><span>予定B</span><span>端末 ／ 回数</span></div>
                ${rows.map(c => `
                    <div class="conflict-row">
                        <span class="when ${tone}">${this.formatDateJp(c.first)}</span>
                        <span><strong>${this.rpaNameOf(c.a.rpaId)}</strong><br><span class="meta">${c.a.startTime}–${c.a.endTime} ／ ${this.scheduleFreqLabel(c.a)}</span></span>
                        <span><strong>${this.rpaNameOf(c.b.rpaId)}</strong><br><span class="meta">${c.b.startTime}–${c.b.endTime} ／ ${this.scheduleFreqLabel(c.b)}</span></span>
                        <span class="meta"><span class="term-dot" style="display:inline-block;background:${c.terminal.color || '#3b82f6'}"></span> ${this.escapeHtml(c.terminal.name)}<br>${this.SCHED_HORIZON_MONTHS}ヶ月で${c.count}回</span>
                    </div>`).join('')}
            </div>`;

        nowBox.innerHTML = now.length
            ? `<div class="sched-alert warn"><div class="hd"><i data-feather="alert-triangle" width="14"></i> いま重複している：${now.length}件</div></div>` + table(now, 'now')
            : `<div class="sched-alert ok"><div class="hd"><i data-feather="check" width="14"></i> 直近1ヶ月に重複はありません</div></div>`;

        futureBox.innerHTML = future.length
            ? `<div class="sched-alert future"><div class="hd"><i data-feather="clock" width="14"></i> 今月は無事だが将来重複する：${future.length}件（表示中の月だけを見ても見つかりません）</div></div>` + table(future, 'future')
            : `<div class="sched-alert ok"><div class="hd"><i data-feather="check" width="14"></i> ${this.SCHED_HORIZON_MONTHS}ヶ月先まで、新たに重複する組み合わせはありません</div></div>`;

        feather.replace();
    },

    timeToMinutes(timeStr) {
        if (!timeStr) return 0;
        const [hours, mins] = timeStr.split(':').map(Number);
        return (hours * 60) + (mins || 0);
    },

    hexToRgba(hex, alpha) {
        let r = parseInt(hex.slice(1, 3), 16),
            g = parseInt(hex.slice(3, 5), 16),
            b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    updateCurrentTimeLine() {
        const now = new Date();
        const mins = (now.getHours() * 60) + now.getMinutes();
        const line = document.getElementById('current-time-line');
        if(line) {
            line.style.left = `${mins}px`;
            // 現在時刻付近に自動スクロール (初回のみ)
            const wrapper = document.getElementById('timeline-wrapper');
            if(wrapper && wrapper.scrollLeft === 0 && mins > 200) {
                // wrapper.scrollLeft = mins - 200; // optionally scroll to current time
            }
        }
    },

    // --- Schedule & Terminal Modal Actions ---

    showScheduleModal(scheduleId = null) {
        if (!this.state.isAdmin) return;
        
        // Populate Selects
        const rpaSelect = document.getElementById('sch-rpa');
        rpaSelect.innerHTML = '<option value="">選択してください</option>' + 
            this.data.rpas.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
            
        const termSelect = document.getElementById('sch-terminal');
        termSelect.innerHTML = '<option value="">選択してください</option>' + 
            this.data.terminals.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

        const modal = document.getElementById('schedule-modal');
        const form = document.getElementById('sch-form');
        form.reset();
        
        if (scheduleId) {
            const sch = this.data.schedules.find(s => s.id === scheduleId);
            if (sch) {
                document.getElementById('sch-modal-title').textContent = 'スケジュールの編集';
                document.getElementById('sch-id').value = sch.id;
                document.getElementById('sch-rpa').value = sch.rpaId;
                document.getElementById('sch-terminal').value = sch.terminalId;
                document.getElementById('sch-start').value = sch.startTime;
                document.getElementById('sch-end').value = sch.endTime;
                document.getElementById('sch-frequency').value = sch.frequency || 'daily';
                this.state.modalDows = (sch.daysOfWeek && sch.daysOfWeek.length) ? sch.daysOfWeek.slice() : [1];
                document.getElementById('sch-day-of-month').value = sch.dayOfMonth || '';
                document.getElementById('sch-once-date').value = sch.date || '';
                document.getElementById('sch-delete-btn').style.display = 'block';
            }
        } else {
            document.getElementById('sch-modal-title').textContent = 'スケジュールの登録';
            document.getElementById('sch-id').value = ''; // FIX: Explicitly clear the hidden id
            this.state.modalDows = [1];
            document.getElementById('sch-day-of-month').value = '';
            document.getElementById('sch-once-date').value = '';
            document.getElementById('sch-delete-btn').style.display = 'none';
        }

        this.renderModalDowPicker();

        // 頻度に応じた入力欄の表示切替イベントを発火
        document.getElementById('sch-frequency').dispatchEvent(new Event('change'));

        modal.classList.add('active');
        feather.replace();
    },

    renderModalDowPicker() {
        const box = document.getElementById('sch-dow-picker');
        if (!box) return;
        if (!this.state.modalDows || !this.state.modalDows.length) this.state.modalDows = [1];
        box.innerHTML = this.WEEKDAY_LABELS.map((w, i) => {
            const on = this.state.modalDows.indexOf(i) >= 0 ? ' active' : '';
            const tone = i === 0 ? ' sun' : i === 6 ? ' sat' : '';
            return `<button type="button" class="${tone}${on}" onclick="App.toggleModalDow(${i})">${w}</button>`;
        }).join('');
    },

    toggleModalDow(i) {
        const cur = this.state.modalDows || [1];
        const next = cur.indexOf(i) >= 0 ? cur.filter(x => x !== i) : cur.concat(i);
        this.state.modalDows = next.length ? next.sort((a, b) => a - b) : [i];
        this.renderModalDowPicker();
        this.renderScheduleModalConflict();
    },

    renderScheduleModalConflict() {
        const box = document.getElementById('sch-conflict');
        if (!box) return;
        const terminalId = document.getElementById('sch-terminal').value;
        const start = document.getElementById('sch-start').value;
        const end = document.getElementById('sch-end').value;
        const freq = document.getElementById('sch-frequency').value;
        const excludeId = document.getElementById('sch-id').value || null;

        if (!terminalId || !start || !end) {
            box.innerHTML = '';
            return;
        }

        const cond = {
            freq,
            dows: this.state.modalDows || [1],
            dom: document.getElementById('sch-day-of-month').value,
            date: document.getElementById('sch-once-date').value
        };
        if (freq === 'monthly' && !cond.dom) { box.innerHTML = ''; return; }
        if (freq === 'once' && !cond.date) { box.innerHTML = ''; return; }

        const term = this.data.terminals.find(t => t.id === terminalId);
        const overnight = this.timeToMinutes(end) <= this.timeToMinutes(start);
        const hits = this.findScheduleConflicts(terminalId, start, end, cond, excludeId);

        const oneMonthLater = new Date();
        oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
        const soon = hits.filter(h => h.first <= oneMonthLater);
        const later = hits.filter(h => h.first > oneMonthLater);

        const line = (h) => `<li>・<strong>${this.rpaNameOf(h.s.rpaId)}</strong> ${h.s.startTime}–${h.s.endTime}（${this.scheduleFreqLabel(h.s)}） → 初回 ${this.formatDateJp(h.first)}${h.nextDay ? '（翌日ぶん）' : ''} ／ ${this.SCHED_HORIZON_MONTHS}ヶ月で${h.count}回</li>`;

        let html = '';
        if (!hits.length) {
            html += `<div class="sched-alert ok"><div class="hd"><i data-feather="check" width="14"></i> ${this.SCHED_HORIZON_MONTHS}ヶ月先まで重複はありません</div>
                <span>${term ? this.escapeHtml(term.name) : ''} ／ ${start}–${end}${overnight ? '（日跨ぎ）' : ''}</span></div>`;
        } else {
            if (soon.length) {
                html += `<div class="sched-alert warn"><div class="hd"><i data-feather="alert-triangle" width="14"></i> すぐに重複します（1ヶ月以内）：${soon.length}件</div><ul>${soon.map(line).join('')}</ul></div>`;
            }
            if (later.length) {
                html += `<div class="sched-alert future"><div class="hd"><i data-feather="clock" width="14"></i> いまは重複しませんが、将来ぶつかります：${later.length}件</div><ul>${later.map(line).join('')}</ul>
                    <div style="margin-top:6px">日付指定と曜日指定が同じ時間帯にあるため、条件が揃った月だけ重複します。</div></div>`;
            }
        }
        if (overnight) {
            html += `<div class="sched-alert note"><div class="hd"><i data-feather="clock" width="14"></i> 日をまたぐ設定です</div>
                <span>翌日 00:00–${end} も占有として扱い、翌日側の予定とも突き合わせます。</span></div>`;
        }
        box.innerHTML = html;
        feather.replace();
    },

    rpaNameOf(rpaId) {
        const rpa = this.data.rpas.find(r => r.id === rpaId);
        return this.escapeHtml(rpa ? rpa.name : '不明なRPA');
    },

    escapeHtml(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    hideScheduleModal() {
        document.getElementById('schedule-modal').classList.remove('active');
    },

    saveSchedule() {
        const id = document.getElementById('sch-id').value;
        const dows = (this.state.modalDows && this.state.modalDows.length) ? this.state.modalDows.slice().sort((a, b) => a - b) : [1];
        const newSch = {
            id: id || 'sch-' + Date.now(),
            rpaId: document.getElementById('sch-rpa').value,
            terminalId: document.getElementById('sch-terminal').value,
            startTime: document.getElementById('sch-start').value,
            endTime: document.getElementById('sch-end').value,
            frequency: document.getElementById('sch-frequency').value,
            daysOfWeek: dows,
            dayOfWeek: String(dows[0]), // 旧フォーマットしか読まない箇所との互換用
            dayOfMonth: document.getElementById('sch-day-of-month').value,
            date: document.getElementById('sch-once-date').value
        };

        if (id) {
            const index = this.data.schedules.findIndex(s => s.id === id);
            if (index > -1) this.data.schedules[index] = newSch;
        } else {
            this.data.schedules.push(newSch);
        }

        this.saveData();
        this.hideScheduleModal();
        this.renderSchedule();
    },

    deleteSchedule() {
        const id = document.getElementById('sch-id').value;
        if (!id || !confirm('このスケジュールを削除しますか？')) return;
        
        this.data.schedules = this.data.schedules.filter(s => s.id !== id);
        this.saveData();
        this.hideScheduleModal();
        this.renderSchedule();
    },

    showTerminalModal() {
        if (!this.state.isAdmin) return;
        this.renderTerminalList();
        document.getElementById('terminal-modal').classList.add('active');
    },

    hideTerminalModal() {
        document.getElementById('terminal-modal').classList.remove('active');
        this.renderSchedule(); // Return to schedule and update headers
    },

    renderTerminalList() {
        const tbody = document.getElementById('terminal-list-body');
        tbody.innerHTML = this.data.terminals.map(t => `
            <tr>
                <td><span style="display:inline-block; width:14px; height:14px; border-radius:3px; background-color:${t.color || '#3b82f6'}; margin-right:8px; vertical-align:middle;"></span>${t.name}</td>
                <td><span class="status-dot ${t.status === 'online' ? 'bg-success' : 'bg-gray'}"></span> Object</td>
                <td class="text-right whitespace-nowrap">
                    <button class="btn btn-ghost btn-sm text-primary mr-1" onclick="App.editTerminal('${t.id}')">
                        <i data-feather="edit-2" width="14"></i>
                    </button>
                    <button class="btn btn-ghost btn-sm text-red-400" onclick="App.deleteTerminal('${t.id}')">
                        <i data-feather="trash-2" width="14"></i>
                    </button>
                </td>
            </tr>
        `).join('');
        if (window.feather) feather.replace();
    },

    editTerminal(id) {
        const term = this.data.terminals.find(t => t.id === id);
        if (!term) return;
        document.getElementById('term-edit-id').value = term.id;
        document.getElementById('term-new-name').value = term.name;
        document.getElementById('term-new-color').value = term.color || '#3b82f6';
        
        document.getElementById('term-form-title').textContent = '端末の編集';
        document.getElementById('term-save-btn').innerHTML = '<i data-feather="save"></i> 更新';
        document.getElementById('term-cancel-btn').style.display = 'block';
        if (window.feather) feather.replace();
    },

    cancelEditTerminal() {
        document.getElementById('term-edit-id').value = '';
        document.getElementById('term-new-name').value = '';
        document.getElementById('term-new-color').value = '#3b82f6';
        
        document.getElementById('term-form-title').textContent = '新しい端末を追加';
        document.getElementById('term-save-btn').innerHTML = '<i data-feather="plus"></i> 追加';
        document.getElementById('term-cancel-btn').style.display = 'none';
        if (window.feather) feather.replace();
    },

    saveTerminal() {
        const idInput = document.getElementById('term-edit-id');
        const nameInput = document.getElementById('term-new-name');
        const colorInput = document.getElementById('term-new-color');
        
        const id = idInput ? idInput.value : '';
        const name = nameInput.value.trim();
        const color = colorInput ? colorInput.value : '#3b82f6';
        if (!name) return;

        if (id) {
            const index = this.data.terminals.findIndex(t => t.id === id);
            if (index > -1) {
                this.data.terminals[index].name = name;
                this.data.terminals[index].color = color;
            }
        } else {
            this.data.terminals.push({
                id: 'term-' + Date.now(),
                name: name,
                color: color,
                status: 'online'
            });
        }

        this.saveData();
        this.cancelEditTerminal();
        this.renderTerminalList();
    },

    deleteTerminal(id) {
        if (!confirm('この端末を削除しますか？関連するスケジュールも非表示になります。')) return;
        this.data.terminals = this.data.terminals.filter(t => t.id !== id);
        this.saveData();
        this.renderTerminalList();
    }
};

// Start App
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});



