const axios = require('axios');
const yargs = require('yargs');

const API_BASE_URL = "https://api.meraki.com/api/v1";
const API_MAX_RETRIES = 3;
const API_CONNECT_TIMEOUT = 60000;
const API_TRANSMIT_TIMEOUT = 60000;
const API_STATUS_RATE_LIMIT = 429;

const argv = yargs
    .option('k', {
        alias: 'apiKey',
        demandOption: true,
        describe: 'Your Meraki Dashboard API key',
        type: 'string'
    })
    .option('o', {
        alias: 'organization',
        demandOption: true,
        describe: 'Dashboard organizations in scope',
        type: 'string'
    })
    .option('c', {
        alias: 'command',
        demandOption: true,
        describe: 'Command to be executed',
        type: 'string'
    })
    .option('a', {
        alias: 'adminEmail',
        describe: 'Email of admin account to be added/deleted/matched',
        type: 'string'
    })
    .option('n', {
        alias: 'adminName',
        describe: 'Name for admin to be added by the "add" command',
        type: 'string'
    })
    .option('p', {
        alias: 'privilegeLevel',
        describe: 'Privilege level for admin to be added by the "add" command',
        default: 'full',
        type: 'string'
    })
    .help()
    .alias('help', 'h')
    .argv;

const apiKey = argv.apiKey;
const organization = argv.organization;
const command = argv.command.toLowerCase();
const adminEmail = argv.adminEmail;
const adminName = argv.adminName;
const privilegeLevel = argv.privilegeLevel;

const axiosInstance = axios.create({
    baseURL: API_BASE_URL,
    timeout: API_CONNECT_TIMEOUT,
    headers: { 'Authorization': `Bearer ${apiKey}` }
});

async function merakiRequest(httpVerb, endpoint, requestBody = null, retry = 0) {
    if (retry > API_MAX_RETRIES) {
        console.error("ERROR: Reached max retries");
        return null;
    }

    try {
        const response = await axiosInstance({
            method: httpVerb,
            url: endpoint,
            data: requestBody,
            timeout: API_TRANSMIT_TIMEOUT
        });

        return response.data;
    } catch (error) {
        if (error.response && error.response.status === API_STATUS_RATE_LIMIT) {
            const retryAfter = error.response.headers['retry-after'];
            console.log(`INFO: Hit max request rate. Retrying ${retry + 1} after ${retryAfter} seconds`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            return merakiRequest(httpVerb, endpoint, requestBody, retry + 1);
        } else {
            console.error(error.message);
            return null;
        }
    }
}

async function getOrganizations() {
    return await merakiRequest('get', '/organizations');
}

async function getOrganizationAdmins(organizationId) {
    return await merakiRequest('get', `/organizations/${organizationId}/admins`);
}

async function createOrganizationAdmin(organizationId, email, name, privilege) {
    const body = { email, name, orgAccess: privilege };
    return await merakiRequest('post', `/organizations/${organizationId}/admins`, body);
}

async function deleteOrganizationAdmin(organizationId, adminId) {
    return await merakiRequest('delete', `/organizations/${organizationId}/admins/${adminId}`);
}

async function updateOrganizationAdmin(organizationId, adminId, privilege) {
    const body = { orgAccess: privilege };
    return await merakiRequest('put', `/organizations/${organizationId}/admins/${adminId}`, body);
}

async function adminIdForEmail(adminList, adminEmail) {
    const admin = adminList.find(admin => admin.email === adminEmail);
    return admin ? admin.id : null;
}

async function filterOrgList(orgList, filter) {
    if (filter === '/all') {
        return orgList;
    }

    return orgList.filter(org => org.name.includes(filter));
}

async function cmdAdd(apiKey, orgs, email, name, privilege) {
    if (!['full', 'read-only'].includes(privilege)) {
        console.error(`Unsupported privilege level "${privilege}"`);
        process.exit(1);
    }

    for (const org of orgs) {
        const orgAdmins = await getOrganizationAdmins(org.id);
        const adminId = await adminIdForEmail(orgAdmins, email);

        if (adminId) {
            console.log(`Skipping org "${org.name}". Admin already exists`);
        } else {
            const response = await createOrganizationAdmin(org.id, email, name, privilege);
            console.log(response ? `Operation successful for org : ${org.name}` : `Operation failed for org : ${org.name}`);
        }
    }
}

async function cmdDelete(apiKey, orgs, adminEmail) {
    for (const org of orgs) {
        const orgAdmins = await getOrganizationAdmins(org.id);
        const adminId = await adminIdForEmail(orgAdmins, adminEmail);

        if (!adminId) {
            console.log(`Skipping org "${org.name}". Admin "${adminEmail}" not found`);
        } else {
            const response = await deleteOrganizationAdmin(org.id, adminId);
            console.log(response ? `Operation successful for org : ${org.name}` : `Operation failed for org : ${org.name}`);
        }
    }
}

async function cmdFind(apiKey, orgList, adminEmail) {
    let matches = 0;
    let buffer = '';

    for (const org of orgList) {
        const orgAdmins = await getOrganizationAdmins(org.id);
        const adminId = await adminIdForEmail(orgAdmins, adminEmail);

        if (adminId) {
            matches++;
            buffer += `Found admin "${adminEmail}" in org "${org.name}"\n`;
        }
    }

    console.log(`\n${matches} matches\n`);
    console.log(buffer);
}

async function cmdList(apiKey, orgList) {
    let buffer = '';

    for (const org of orgList) {
        const orgAdmins = await getOrganizationAdmins(org.id);
        if (orgAdmins) {
            buffer += `\nAdministrators for org "${org.name}"\n`;
            buffer += `Name                            Email                           Org Privilege\n`;
            for (const admin of orgAdmins) {
                buffer += `${admin.name}                      ${admin.email}                   ${admin.orgAccess}\n`;
            }
        }
    }

    console.log(buffer);
}

async function cmdUpdate(apiKey, orgs, email, privilege) {
    for (const org of orgs) {
        const orgAdmins = await getOrganizationAdmins(org.id);
        const adminId = await adminIdForEmail(orgAdmins, email);

        if (!adminId) {
            console.log(`Skipping org "${org.name}". Admin "${email}" not found`);
        } else {
            const response = await updateOrganizationAdmin(org.id, adminId, privilege);
            console.log(response ? `Operation successful for org : ${org.name}` : `Operation failed for org : ${org.name}`);
        }
    }
}

async function main() {
    const orgList = await getOrganizations();
    if (!orgList) {
        console.error('Error retrieving organization list');
        process.exit(1);
    }

    const matchedOrgs = await filterOrgList(orgList, organization);

    switch (command) {
        case 'add':
            if (!adminEmail || !adminName) {
                console.error('Command "add" needs parameters -a <adminEmail> and -n <adminName>');
                process.exit(1);
            }
            await cmdAdd(apiKey, matchedOrgs, adminEmail, adminName, privilegeLevel);
            break;
        case 'delete':
            if (!adminEmail) {
                console.error('Command "delete" needs parameter -a <adminEmail>');
                process.exit(1);
            }
            await cmdDelete(apiKey, matchedOrgs, adminEmail);
            break;
        case 'find':
            if (!adminEmail) {
                console.error('Command "find" needs parameter -a <adminEmail>');
                process.exit(1);
            }
            await cmdFind(apiKey, matchedOrgs, adminEmail);
            break;
        case 'list':
            await cmdList(apiKey, matchedOrgs);
            break;
        case 'update':
            if (!adminEmail || !privilegeLevel) {
                console.error('Command "update" needs parameters -a <adminEmail> and -p <privilegeLevel>');
                process.exit(1);
            }
            await cmdUpdate(apiKey, matchedOrgs, adminEmail, privilegeLevel);
            break;
        default:
            console.error(`Invalid command "${command}"`);
            process.exit(1);
    }
}

main();
