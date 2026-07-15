<template>
    <div class="my-4">
        <div class="mb-4">
            <label for="registry-endpoint" class="form-label">
                {{ $t("dockgeAgent") }}
            </label>
            <select
                id="registry-endpoint"
                v-model="endpoint"
                class="form-select"
                :disabled="busy || showLogoutDialog"
            >
                <option
                    v-for="(agent, agentEndpoint) in $root.agentList"
                    :key="agentEndpoint"
                    :value="agentEndpoint"
                    :disabled="$root.agentStatusList[agentEndpoint] != 'online'"
                >
                    ({{ $root.agentStatusList[agentEndpoint] }}) {{ (agent.name !== "") ? agent.name : agent.url || $t("currentEndpoint") }}
                </option>
            </select>
        </div>

        <h5 class="my-4 settings-subheading">{{ $t("loggedInRegistries") }}</h5>

        <div v-if="loadingList" class="mb-4 text-muted">
            {{ $t("loading") }}
        </div>

        <div v-else-if="registries.length === 0" class="mb-4 text-muted">
            {{ $t("noRegistriesLoggedIn") }}
        </div>

        <div v-else class="table-responsive mb-4">
            <table class="table">
                <thead>
                    <tr>
                        <th>{{ $t("registryServer") }}</th>
                        <th>{{ $t("Username") }}</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="registry in registries" :key="registry.server">
                        <td>
                            <code>{{ registry.server }}</code>
                            <span
                                v-if="registry.server === dockerHubServer"
                                class="badge bg-secondary ms-2"
                            >{{ $t("dockerHub") }}</span>
                        </td>
                        <td>{{ registry.username || "-" }}</td>
                        <td class="text-end">
                            <button
                                type="button"
                                class="btn btn-sm btn-danger"
                                :disabled="busy"
                                @click="confirmLogout(registry.server)"
                            >
                                {{ $t("dockerRegistryLogout") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <h5 class="my-4 settings-subheading">{{ $t("addRegistry") }}</h5>

        <form autocomplete="off" @submit.prevent="login">
            <div class="mb-3">
                <label for="registry-server" class="form-label">
                    {{ $t("registryServer") }}
                </label>
                <input
                    id="registry-server"
                    v-model="registryServer"
                    type="text"
                    class="form-control"
                    placeholder="ghcr.io / git.example.com"
                    autocapitalize="none"
                    autocomplete="off"
                    spellcheck="false"
                    :disabled="busy"
                />
                <div class="form-text">
                    {{ $t("registryServerHelp") }}
                </div>
            </div>

            <div class="mb-3">
                <label for="registry-username" class="form-label">
                    {{ $t("Username") }}
                </label>
                <input
                    id="registry-username"
                    v-model="username"
                    type="text"
                    class="form-control"
                    autocapitalize="none"
                    autocomplete="off"
                    spellcheck="false"
                    required
                    :disabled="busy"
                />
            </div>

            <div class="mb-3">
                <label for="registry-password" class="form-label">
                    {{ $t("registryPassword") }}
                </label>
                <input
                    id="registry-password"
                    v-model="password"
                    type="password"
                    class="form-control"
                    autocomplete="new-password"
                    required
                    :disabled="busy"
                />
            </div>

            <button class="btn btn-primary" type="submit" :disabled="busy">
                <template v-if="busy">{{ $t("connecting") }}</template>
                <template v-else>{{ $t("dockerRegistryLogin") }}</template>
            </button>
        </form>

        <BModal
            v-model="showLogoutDialog"
            :cancelTitle="$t('cancel')"
            :okTitle="$t('dockerRegistryLogout')"
            okVariant="danger"
            @ok="logout"
        >
            <p>
                <code>{{ logoutServer }}</code>
            </p>
            {{ $t("dockerRegistryLogoutConfirm") }}
        </BModal>
    </div>
</template>

<script>
import { BModal } from "bootstrap-vue-next";

const DOCKER_HUB_SERVER = "https://index.docker.io/v1/";

export default {
    name: "Registry",

    components: {
        BModal,
    },

    data() {
        return {
            endpoint: "",
            registryServer: "",
            username: "",
            password: "",
            registries: [],
            loadingList: false,
            busy: false,
            showLogoutDialog: false,
            logoutServer: "",
            logoutEndpoint: "",
            listRequestId: 0,
            dockerHubServer: DOCKER_HUB_SERVER,
        };
    },

    watch: {
        endpoint() {
            this.loadRegistries();
        },
    },

    mounted() {
        this.loadRegistries();
    },

    methods: {
        /** Load logged-in registries for the selected endpoint */
        loadRegistries() {
            const endpoint = this.endpoint;
            const requestId = ++this.listRequestId;
            this.loadingList = true;
            this.$root.emitAgent(endpoint, "getDockerRegistries", (res) => {
                if (requestId !== this.listRequestId || endpoint !== this.endpoint) {
                    return;
                }
                this.loadingList = false;
                if (res.ok) {
                    this.registries = res.registries || [];
                } else {
                    this.registries = [];
                    this.$root.toastRes(res);
                }
            });
        },

        /** Submit registry credentials to the selected endpoint */
        login() {
            const endpoint = this.endpoint;
            this.busy = true;
            this.$root.emitAgent(endpoint, "dockerLogin", this.registryServer, this.username, this.password, (res) => {
                if (endpoint !== this.endpoint) {
                    return;
                }
                this.busy = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.password = "";
                    this.loadRegistries();
                }
            });
        },

        /** Open logout confirmation for a registry */
        confirmLogout(server) {
            this.logoutServer = server;
            this.logoutEndpoint = this.endpoint;
            this.showLogoutDialog = true;
        },

        /** Log out of the selected registry on the endpoint captured when confirming */
        logout() {
            const endpoint = this.logoutEndpoint;
            const server = this.logoutServer;
            this.busy = true;
            this.$root.emitAgent(endpoint, "dockerLogout", server, (res) => {
                this.busy = false;
                this.$root.toastRes(res);
                if (res.ok && endpoint === this.endpoint) {
                    this.loadRegistries();
                }
            });
        },
    },
};
</script>
