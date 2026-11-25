package com.englishcoach.garden;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

/**
 * A TCP relay between the test's connection pool and PostgreSQL that counts network round trips as the wire shows
 * them (Phase 5): one round trip = the client starts sending after the server last spoke. It is the measure that
 * matters in production, where every such exchange costs about 91 ms whatever it carries — a multi-statement exchange
 * counts once, a COMMIT counts once, a pool validation counts once. {@code delayMillis} holds every first packet of a
 * direction change back by that long, which makes an exchange cost twice the delay (a far database, in a test).
 */
final class WireProxy implements AutoCloseable {

    private final ServerSocket server;
    private final String upstreamHost;
    private final int upstreamPort;
    private final AtomicLong roundTrips = new AtomicLong();
    private final List<Socket> sockets = new CopyOnWriteArrayList<>();
    volatile long delayMillis;

    WireProxy(String upstreamHost, int upstreamPort) throws IOException {
        this.upstreamHost = upstreamHost;
        this.upstreamPort = upstreamPort;
        this.server = new ServerSocket(0, 64, InetAddress.getLoopbackAddress());
        Thread accept = new Thread(this::accept, "garden-wire-accept");
        accept.setDaemon(true);
        accept.start();
    }

    int port() {
        return server.getLocalPort();
    }

    long roundTrips() {
        return roundTrips.get();
    }

    private void accept() {
        while (!server.isClosed()) {
            try {
                Socket client = server.accept();
                Socket upstream = new Socket(upstreamHost, upstreamPort);
                client.setTcpNoDelay(true);
                upstream.setTcpNoDelay(true);
                sockets.add(client);
                sockets.add(upstream);
                boolean[] serverSpokeLast = {true};
                pump(client, upstream, true, serverSpokeLast);
                pump(upstream, client, false, serverSpokeLast);
            } catch (IOException e) {
                return;
            }
        }
    }

    private void pump(Socket from, Socket to, boolean clientToServer, boolean[] serverSpokeLast) {
        Thread t = new Thread(() -> {
            byte[] buffer = new byte[64 * 1024];
            try (InputStream in = from.getInputStream(); OutputStream out = to.getOutputStream()) {
                int n;
                while ((n = in.read(buffer)) >= 0) {
                    boolean turn;
                    synchronized (serverSpokeLast) {
                        turn = serverSpokeLast[0] == clientToServer;
                        serverSpokeLast[0] = !clientToServer;
                    }
                    if (turn) {
                        if (clientToServer) roundTrips.incrementAndGet();
                        long delay = delayMillis;
                        if (delay > 0) Thread.sleep(delay);
                    }
                    out.write(buffer, 0, n);
                    out.flush();
                }
            } catch (IOException | InterruptedException ignored) {
                // a closed connection ends its relay
            } finally {
                try {
                    from.close();
                    to.close();
                } catch (IOException ignored) {
                    // already closed
                }
            }
        }, "garden-wire-" + (clientToServer ? "up" : "down"));
        t.setDaemon(true);
        t.start();
    }

    @Override
    public void close() {
        try {
            server.close();
        } catch (IOException ignored) {
            // closing
        }
        for (Socket s : sockets) {
            try {
                s.close();
            } catch (IOException ignored) {
                // closing
            }
        }
    }
}
