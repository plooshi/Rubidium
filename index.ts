import { sleep } from 'bun';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from "uuid";
import config from "./config.json";

function RubidiumLog(...messages: string[]) 
{
    console.log(`\x1b[37m[\x1b[34mRubidium\x1b[0m\x1b[37m]`, ...messages);
}

function sendMessage(socket: Bun.ServerWebSocket<unknown>, type: string, payload: any)
{
    socket.send(JSON.stringify({
        payload: payload,
        name: type
    }));
};

const ConnectingPlayers: String[] = [];
const QueuedPlayers: { [key: string]: any } = {};
const SessionMap: { [key: string]: any } = {};
const Clients: Bun.ServerWebSocket<RubidiumSocketData>[] = [];

interface RubidiumSessionData
{
    SignatureData: { [key: string]: any },
    SessionId: string,
    BucketId: string,
    Players: Bun.ServerWebSocket<RubidiumSocketData>[],
    MatchId: string
}
Bun.serve<RubidiumSessionData, {}>({
    port: config.Ports.DedicatedServerSocket,
    hostname: "0.0.0.0",
    websocket: {
        async open(ws)
        {
            sendMessage(ws, "Registered", {});
            let playerCount = 0;
            const GetPlayersForMatch = async (ws: Bun.ServerWebSocket<RubidiumSessionData>) =>
            {
                while (true)
                {
                    const players: String[][][] = [];
                    if (!QueuedPlayers[ws.data.BucketId])
                        QueuedPlayers[ws.data.BucketId] = [];

                    if (QueuedPlayers[ws.data.BucketId].length > 0)
                    {
                        for (let i = 0; i < QueuedPlayers[ws.data.BucketId].length; i++)
                        {
                            const party = QueuedPlayers[ws.data.BucketId][i];
                            if (playerCount + party.length > 100)
                                break;
                            playerCount += party.length;
                            players.push([party]);
                            for (const member of party)
                            {
                                for (const client of Clients)
                                {
                                    if (client.data.AccountId == member)
                                    {
                                        ws.data.Players.push(client);
                                        break;
                                    }
                                }
                            }
                            QueuedPlayers[ws.data.BucketId].splice(i, 1);
                            i--;
                        }
                        return players;
                    }
                    else
                    {
                        await sleep(100);
                    }
                }
            }
            const assignedPlayers = await GetPlayersForMatch(ws);
            const matchId = uuid().replace(/-/g, "");
            ws.data.MatchId = matchId;

            for (const client of ws.data.Players)
            {
                sendMessage(client, "StatusUpdate", {
                    matchId,
                    state: "SessionAssignment",
                });
            }

            SessionMap[ws.data.SessionId] = {
                sessionId: ws.data.SessionId,
                identifier: ws.data.SessionId,
                bucketId: ws.data.BucketId.split(":")[0],
                region: ws.data.SignatureData.region,
                playlist: ws.data.SignatureData.playlist,
                clients: playerCount,
                serverAddress: ws.data.SignatureData.serverAddress,
                serverPort: parseInt(ws.data.SignatureData.serverPort)
            };

            sendMessage(ws, "AssignMatch", {
                bucketId: `Fortnite:Fortnite:${ws.data.SignatureData.buildUniqueId}:0:${ws.data.SignatureData.region}:${ws.data.SignatureData.playlist}`,
                matchId: matchId,
                matchOptions: "",
                matchOptionsV2: {},
                spectators: [],
                teams: assignedPlayers
            });
        },
        async message(ws, message) 
        {
            if (message == "ping")
                return;
            const data = JSON.parse(message.toString());
            if (data.payload.result == "ready")
            {
                for (const client of ws.data.Players)
                {
                    sendMessage(client, "Play", {
                        matchId: ws.data.MatchId,
                        sessionId: ws.data.SessionId,
                        joinDelaySec: 0,
                    });
                }
            }
        },
        async close(ws, code, message)
        {
        }
    },
    fetch: (req, server) =>
    {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader)
            return new Response(null, { status: 404 });
        const splitAuthHeader = authHeader.split(" ");
        if (splitAuthHeader.length < 4)
            return new Response(null, { status: 404 });
        let signatureDecoded: any = {};
        try
        {
            signatureDecoded = jwt.verify(splitAuthHeader[3], config.SecretKey);
        } catch
        {
            return new Response(null, { status: 404 });
        }
        if (!server.upgrade(req, { data: { SignatureData: signatureDecoded, BucketId: signatureDecoded["bucketIds"], SessionId: splitAuthHeader[2].replaceAll("\"", ""), Players: [] } }))
            return new Response(null, { status: 404 });
    }
});

interface RubidiumSocketData
{
    SignatureData: { [key: string]: any },
    AccountId: string,
    BucketId: string,
    TicketId: string,
    Region: string,
    Playlist: string
}

Bun.serve({ 
    port: config.Ports.API,
    hostname: "0.0.0.0",
    routes: {
        "/solstice/api/v1/servers/:sessionId": {
            async GET(req)  
            {
                return Response.json(SessionMap[req.params.sessionId]);
            }
        },
        "/crystal/restapi/v1/matchmaking/sessions/playlists/:region":
        {
            async GET(req)
            {
                const PlaylistCounts: { [playlist: string]: number } = {};
                for (const client of Clients)
                {
                    if (client.data.Region != req.params.region)
                        continue;

                    
                    if (!PlaylistCounts[client.data.Playlist])
                        PlaylistCounts[client.data.Playlist] = 1;
                    else
                        PlaylistCounts[client.data.Playlist]++;
                }
                const SortedCounts = Object.entries(PlaylistCounts).sort((a, b) => b[1] - a[1]);
                if (SortedCounts.length > 0)
                {
                    const TopPlaylist = SortedCounts[0];
                    return Response.json({ playlist: TopPlaylist[0], count: TopPlaylist[1] });
                }
                else {
                    return Response.json({ playlist: "playlist_showdownalt_solo", count: 67 }); // fallback to lategame solo
                }
            }
        }
    }
});

Bun.serve<RubidiumSocketData, {}>({
    port: config.Ports.MatchmakerSocket,
    hostname: "0.0.0.0",
    websocket: {
        async open(ws)
        {
            Clients.push(ws);
            ConnectingPlayers.push(ws.data.AccountId);
            sendMessage(ws, "StatusUpdate", { "state": "Connecting" });
            RubidiumLog(ws.data.AccountId, "Connected!");

            const WaitForPartyMembers = async (ws: Bun.ServerWebSocket<RubidiumSocketData>) => {
                while (true)
                {
                    let connectedAmt = 0;
                    if (typeof ws.data.SignatureData.partyMembers != "string")
                    {
                        for (const accountId of ConnectingPlayers)
                        {
                            for (const partyPlayerId of ws.data.SignatureData.partyMembers)
                            {
                                if (accountId == partyPlayerId)
                                {
                                    connectedAmt++;
                                    break;
                                }
                            }
                        }
                        if (connectedAmt == ws.data.SignatureData.partyMembers.length)
                            return;
                    }

                    sendMessage(ws, "StatusUpdate", {
                        totalPlayers: ws.data.SignatureData.partyMembers.length,
                        connectedPlayers: connectedAmt,
                        state: "Waiting",
                    });
                    if (typeof ws.data.SignatureData.partyMembers == "string" || connectedAmt == ws.data.SignatureData.partyMembers.length)
                        return;
                    await sleep(10);
                }
            };

            await WaitForPartyMembers(ws);
            RubidiumLog(ws.data.AccountId, "State: Connecting -> Waiting");
            await sleep(50);
            ConnectingPlayers.splice(ConnectingPlayers.indexOf(ws.data.AccountId), 1);

            if (!QueuedPlayers[ws.data.BucketId])
                QueuedPlayers[ws.data.BucketId] = [];
            let alreadyQueued = false; // another party member can place your client into queue
            for (const party of QueuedPlayers[ws.data.BucketId])
            {
                for (const accountId of party)
                {
                    if (accountId == ws.data.AccountId)
                    {
                        alreadyQueued = true;
                        break;
                    }
                }

                if (alreadyQueued)
                    break;
            }
            if (!alreadyQueued)
            {
                if (typeof ws.data.SignatureData.partyMembers == "string")
                    QueuedPlayers[ws.data.BucketId].push([ ws.data.SignatureData.partyMembers ]);
                else
                    QueuedPlayers[ws.data.BucketId].push(ws.data.SignatureData.partyMembers);
            }
            RubidiumLog(ws.data.AccountId, "Added to queue for ");
        
            sendMessage(ws, "StatusUpdate", {
                ticketId: ws.data.TicketId,
                queuedPlayers: 0,
                estimatedWaitSec: 300 * Math.random(),
                status: {},
                state: "Queued",
            });
        },
        async message(ws, message) 
        {
            sendMessage(ws, "StatusUpdate", {
                ticketId: ws.data.TicketId,
                queuedPlayers: 0,
                estimatedWaitSec: 300 * Math.random(),
                status: {},
                state: "Queued",
            });
        },
        async close(ws, code, message)
        {
            if (ConnectingPlayers.indexOf(ws.data.AccountId) != -1)
                ConnectingPlayers.splice(ConnectingPlayers.indexOf(ws.data.AccountId), 1);
            if (QueuedPlayers[ws.data.BucketId] && QueuedPlayers[ws.data.BucketId].indexOf(ws.data.SignatureData.partyMembers) != -1)
                QueuedPlayers[ws.data.BucketId].splice(QueuedPlayers[ws.data.BucketId].indexOf(ws.data.SignatureData.partyMembers), 1);
            if (Clients.indexOf(ws) != -1)
                Clients.splice(Clients.indexOf(ws), 1);
        }
    },
    fetch: (req, server) =>
    {
        const authHeader = req.headers.get("Authorization");
        if (!authHeader)
            return new Response(null, { status: 404 });
        const splitAuthHeader = authHeader.split(" ");
        if (splitAuthHeader.length < 4)
            return new Response(null, { status: 404 });
        let signatureDecoded: any = {};
        try
        {
            const sigJwt = authHeader.split("} ")[1].split(" ")[0];
            signatureDecoded = jwt.verify(sigJwt, config.SecretKey);
        } catch
        {
            return new Response(null, { status: 404 });
        }
        const bucketId = signatureDecoded["bucketId"];
        let newBucketIdSplit = bucketId.split(":");
        newBucketIdSplit[1] = "*";
        const newBucketId = newBucketIdSplit.join(":");
        if (!server.upgrade(req, { data: { SignatureData: signatureDecoded, AccountId: signatureDecoded["accountId"], BucketId: newBucketId, TicketId: uuid().replace(/-/g, ""), Region: signatureDecoded["region"], Playlist: signatureDecoded["playlist"] } }))
            return new Response(null, { status: 404 });
    }
});

RubidiumLog("Listening");