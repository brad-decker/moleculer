const ServiceBroker = require("../../../src/service-broker");
const Transit = require("../../../src/transit");
const { PacketInfo, PacketEvent, PacketRequest } = require("../../../src/packets");
const { protectReject } = require("../utils");

jest.mock("amqplib");

let Amqp = require("amqplib");
Amqp.connect = jest.fn(() => {
	let connectionOnCallbacks = {};
	const ref = {};
	ref.connection = {
		on: jest.fn((event, cb) => {
			connectionOnCallbacks[event] = cb;
			return ref.connection;
		}),
		close: jest.fn(),
		connectionOnCallbacks,
		createChannel: jest.fn(() => {
			let channelOnCallbacks = {};
			let ref = {};
			ref.channel = {
				prefetch: jest.fn(),
				on: jest.fn((event, cb) => {
					channelOnCallbacks[event] = cb;
					return ref.channel;
				}),
				unbindQueue: jest.fn(() => Promise.resolve()),
				bindQueue: jest.fn(() => Promise.resolve()),
				assertExchange: jest.fn(() => Promise.resolve()),
				assertQueue: jest.fn(() => Promise.resolve()),
				consume: jest.fn(() => Promise.resolve()),
				close: jest.fn(() => Promise.resolve()),

				publish: jest.fn(),
				ack: jest.fn(),
				sendToQueue: jest.fn(),
				channelOnCallbacks,
			};

			return Promise.resolve(ref.channel);
		}),
	};
	return Promise.resolve(ref.connection);
});

const AmqpTransporter = require("../../../src/transporters/amqp");


describe("Test AmqpTransporter constructor", () => {

	it("check constructor with string param", () => {
		let transporter = new AmqpTransporter("amqp://localhost");
		expect(transporter).toBeDefined();
		expect(transporter.opts).toEqual({
			amqp: {
				url: "amqp://localhost",
				prefetch: 1,
				eventTimeToLive: null,
				heartbeatTimeToLive: null,
				exchangeOptions: {},
				messageOptions: {},
				queueOptions: {},
				consumeOptions: {}
			}
		});
		expect(transporter.connected).toBe(false);
		expect(transporter.hasBuiltInBalancer).toBe(true);
		expect(transporter.channel).toBeNull();
		expect(transporter.connection).toBeNull();
		expect(transporter.bindings).toHaveLength(0);
	});

	it("check constructor with options", () => {
		let opts = {
			amqp: {
				url: "amqp://localhost",
				prefetch: 3,
				eventTimeToLive: 10000,
				heartbeatTimeToLive: 30000,
				exchangeOptions: { alternateExchange: "retry" },
				messageOptions: { expiration: 120000, persistent: true, mandatory: true },
				queueOptions: { deadLetterExchange: "dlx", maxLength: 100 },
				consumeOptions: { priority: 5 }
			},
		};
		let transporter = new AmqpTransporter(opts);
		expect(transporter.opts).toEqual(opts);
	});
});

describe("Test AmqpTransporter connect & disconnect", () => {
	let broker = new ServiceBroker();
	let transit = new Transit(broker);
	let msgHandler = jest.fn();
	let transporter;

	beforeEach(() => {
		transporter = new AmqpTransporter({ amqp: { url: "amqp://localhost", prefetch: 3 } });
		transporter.init(transit, msgHandler);
	});

	it("check connect", () => {
		return transporter.connect().catch(protectReject).then(() => {
			expect(transporter.connection).toBeDefined();
			expect(transporter.connection.on).toHaveBeenCalledTimes(4);
			expect(transporter.connection.on).toHaveBeenCalledWith("error", jasmine.any(Function));
			expect(transporter.connection.on).toHaveBeenCalledWith("close", jasmine.any(Function));
			expect(transporter.connection.on).toHaveBeenCalledWith("blocked", jasmine.any(Function));
			expect(transporter.connection.on).toHaveBeenCalledWith("unblocked", jasmine.any(Function));
			expect(transporter.channel).toBeDefined();
			expect(transporter.channel.on).toHaveBeenCalledTimes(4);
			expect(transporter.channel.on).toHaveBeenCalledWith("error", jasmine.any(Function));
			expect(transporter.channel.on).toHaveBeenCalledWith("close", jasmine.any(Function));
			expect(transporter.channel.on).toHaveBeenCalledWith("return", jasmine.any(Function));
			expect(transporter.channel.on).toHaveBeenCalledWith("drain", jasmine.any(Function));
			expect(transporter.channel.prefetch).toHaveBeenCalledTimes(1);
			expect(transporter.channel.prefetch).toHaveBeenCalledWith(3);
		});
	});

	it("check onConnected after connect", () => {
		transporter.onConnected = jest.fn(() => Promise.resolve());
		return transporter.connect().catch(protectReject).then(() => {
			expect(transporter.onConnected).toHaveBeenCalledTimes(1);
			expect(transporter.onConnected).toHaveBeenCalledWith();
		});
	});

	it("check disconnect", () => {
		transporter.bindings = [["queue1", "exchange1", ""], ["queue2", "exchange2", ""]];
		return transporter.connect().catch(protectReject).then(() => {
			let chanCloseCb = transporter.channel.close;
			let chanUnbindCb = transporter.channel.unbindQueue;
			let conCloseCb = transporter.connection.close;
			let bindings = transporter.bindings;
			transporter.disconnect()
				.catch(protectReject).then(() => {
					expect(transporter.channel).toBeNull();
					expect(transporter.connection).toBeNull();
					expect(chanCloseCb).toHaveBeenCalledTimes(1);
					expect(conCloseCb).toHaveBeenCalledTimes(1);

					expect(chanUnbindCb).toHaveBeenCalledTimes(bindings.length);
					for (let binding of bindings) {
						expect(chanUnbindCb).toHaveBeenCalledWith(...binding);
					}
				});
		});
	});
});


describe("Test AmqpTransporter subscribe", () => {
	let transporter;
	let msgHandler;
	let broker;

	beforeEach(() => {
		broker = new ServiceBroker({ namespace: "TEST", nodeID: "node", internalServices: false });
		msgHandler = jest.fn();
		transporter = new AmqpTransporter({ amqp: { url: "amqp://localhost", eventTimeToLive: 3000 }});
		transporter.init(new Transit(broker), msgHandler);
		return transporter.connect();
	});

	it("should not call channel.ack", () => {
		transporter.channel.ack = jest.fn();
		transporter.channel.nack = jest.fn();

		let cb = transporter._consumeCB("REQ", false);

		let msg = { content: "msg" };
		cb(msg);

		expect(msgHandler).toHaveBeenCalledTimes(1);
		expect(msgHandler).toHaveBeenCalledWith("REQ", msg.content);

		expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
		expect(transporter.channel.nack).toHaveBeenCalledTimes(0);
	});

	it("should call channel.ack (sync)", () => {
		transporter.channel.ack = jest.fn();
		transporter.channel.nack = jest.fn();

		let cb = transporter._consumeCB("REQ", true);

		let msg = { content: "msg" };
		cb(msg);

		expect(msgHandler).toHaveBeenCalledTimes(1);
		expect(msgHandler).toHaveBeenCalledWith("REQ", msg.content);
		expect(transporter.channel.ack).toHaveBeenCalledTimes(1);
		expect(transporter.channel.ack).toHaveBeenCalledWith(msg);
		expect(transporter.channel.nack).toHaveBeenCalledTimes(0);
	});
/*
	it("should call channel.ack (async)", () => {
		transporter.channel.ack = jest.fn();
		transporter.channel.nack = jest.fn();
		transporter.messageHandler = jest.fn(() => Promise.resolve());

		let cb = transporter._consumeCB("REQ", true);

		let msg = { content: "msg" };
		return cb(msg).catch(protectReject).then(() => {
			expect(transporter.messageHandler).toHaveBeenCalledTimes(1);
			expect(transporter.channel.ack).toHaveBeenCalledTimes(1);
			expect(transporter.channel.ack).toHaveBeenCalledWith(msg);
			expect(transporter.channel.nack).toHaveBeenCalledTimes(0);
		});
	});

	it("should call channel.nack (async)", () => {
		transporter.channel.ack = jest.fn();
		transporter.channel.nack = jest.fn();
		transporter.messageHandler = jest.fn(() => Promise.reject());

		let cb = transporter._consumeCB("REQ", true);

		let msg = { content: "msg" };
		return cb(msg).catch(protectReject).then(() => {
			expect(transporter.messageHandler).toHaveBeenCalledTimes(1);
			expect(transporter.channel.nack).toHaveBeenCalledTimes(1);
			expect(transporter.channel.nack).toHaveBeenCalledWith(msg);
			expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
		});
	});*/
});

describe("Test AmqpTransporter subscribe", () => {
	let transporter;
	let msgHandler;
	let broker;

	beforeEach(() => {
		broker = new ServiceBroker({ namespace: "TEST", nodeID: "node", internalServices: false });
		msgHandler = jest.fn();
		transporter = new AmqpTransporter({
			amqp: { url: "amqp://localhost", eventTimeToLive: 3000, heartbeatTimeToLive: 4000 }
		});
		transporter.init(new Transit(broker), msgHandler);
		return transporter.connect();
	});

	it("check RES subscription", () => {
		return transporter.subscribe("RES", "node")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.RES.node", {});
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith("MOL-TEST.RES.node", jasmine.any(Function), { noAck: true });

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
			});
	});

	it("check INFO.nodeID subscription", () => {
		transporter.getTopicName = () => "MOL-TEST.INFO.node";
		return transporter.subscribe("INFO", "node")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.INFO.node", {"autoDelete": true});
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith("MOL-TEST.INFO.node", jasmine.any(Function), { noAck: true });

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
			});
	});


	it("check REQ.nodeID subscription", () => {
		transporter.getTopicName = () => "MOL-TEST.REQ.node";
		return transporter.subscribe("REQ", "node")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.REQ.node", {});
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith("MOL-TEST.REQ.node", jasmine.any(Function), { noAck: false });

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(1);
			});
	});

	it("check EVENT subscription", () => {
		return transporter.subscribe("EVENT", "node")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertExchange).toHaveBeenCalledTimes(0);
				expect(transporter.channel.bindQueue).toHaveBeenCalledTimes(0);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);

				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.EVENT.node", { messageTtl: 3000 }); // use ttl option
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith("MOL-TEST.EVENT.node", jasmine.any(Function), { noAck: true });

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
			});
	});

	it("check HEARTBEAT subscription", () => {
		return transporter.subscribe("HEARTBEAT")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertExchange).toHaveBeenCalledTimes(1);
				expect(transporter.channel.bindQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);

				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.HEARTBEAT.node", { autoDelete: true, messageTtl: 4000});
				expect(transporter.channel.assertExchange)
					.toHaveBeenCalledWith("MOL-TEST.HEARTBEAT", "fanout", {});
				expect(transporter.channel.bindQueue)
					.toHaveBeenCalledWith("MOL-TEST.HEARTBEAT.node", "MOL-TEST.HEARTBEAT", "");
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith(
						"MOL-TEST.HEARTBEAT.node",
						jasmine.any(Function),
						{ noAck: true }
					);

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
			});
	});

	["DISCOVER", "DISCONNECT", "INFO"].forEach(type => {
		it(`check ${type} subscription`, () => {
			return transporter.subscribe(type)
				.catch(protectReject).then(() => {
					expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
					expect(transporter.channel.assertExchange).toHaveBeenCalledTimes(1);
					expect(transporter.channel.bindQueue).toHaveBeenCalledTimes(1);
					expect(transporter.channel.consume).toHaveBeenCalledTimes(1);

					expect(transporter.channel.assertQueue)
						.toHaveBeenCalledWith(`MOL-TEST.${type}.node`, { autoDelete: true });
					expect(transporter.channel.assertExchange)
						.toHaveBeenCalledWith(`MOL-TEST.${type}`, "fanout", {});
					expect(transporter.channel.bindQueue)
						.toHaveBeenCalledWith(`MOL-TEST.${type}.node`, `MOL-TEST.${type}`, "");
					expect(transporter.channel.consume)
						.toHaveBeenCalledWith(
							`MOL-TEST.${type}.node`,
							jasmine.any(Function),
							{ noAck: true }
						);

					const consumeCb = transporter.channel.consume.mock.calls[0][1];
					consumeCb({ content: Buffer.from("data") });

					expect(msgHandler).toHaveBeenCalledTimes(1);
					expect(transporter.channel.ack).toHaveBeenCalledTimes(0);
				});
		});
	});

	it("check subscribeBalancedRequest", () => {
		return transporter.subscribeBalancedRequest("posts.find")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.REQB.posts.find", {});
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith("MOL-TEST.REQB.posts.find", jasmine.any(Function), {});

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(1);
			});
	});

	it("check subscribeBalancedEvent", () => {
		return transporter.subscribeBalancedEvent("cache.clear", "posts")
			.catch(protectReject).then(() => {
				expect(transporter.channel.assertQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.consume).toHaveBeenCalledTimes(1);
				expect(transporter.channel.assertQueue)
					.toHaveBeenCalledWith("MOL-TEST.EVENTB.posts.cache.clear",
						{ messageTtl: 3000});
				expect(transporter.channel.consume)
					.toHaveBeenCalledWith("MOL-TEST.EVENTB.posts.cache.clear", jasmine.any(Function), {});

				const consumeCb = transporter.channel.consume.mock.calls[0][1];
				consumeCb({ content: Buffer.from("data") });

				expect(msgHandler).toHaveBeenCalledTimes(1);
				expect(transporter.channel.ack).toHaveBeenCalledTimes(1);
			});
	});
});

describe("Test AmqpTransporter publish", () => {
	let transporter;
	let msgHandler;

	const fakeTransit = {
		nodeID: "node1",
		serialize: jest.fn(msg => JSON.stringify(msg))
	};

	beforeEach(() => {
		msgHandler = jest.fn();
		transporter = new AmqpTransporter({ amqp: { url: "amqp://localhost", eventTimeToLive: 3000 }});
		transporter.init(new Transit(new ServiceBroker({ namespace: "TEST" })), msgHandler);
		return transporter.connect();
	});

	it("check publish with target", () => {
		const packet = new PacketInfo(fakeTransit, "node2", {});
		return transporter.publish(packet)
			.catch(protectReject).then(() => {
				expect(transporter.channel.sendToQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.sendToQueue).toHaveBeenCalledWith(
					"MOL-TEST.INFO.node2",
					Buffer.from(JSON.stringify({"ver": "2", "sender": "node1"})),
					{}
				);
			});
	});

	it("check publish without target", () => {
		const packet = new PacketInfo(fakeTransit, null, {});
		return transporter.publish(packet)
			.catch(protectReject).then(() => {
				expect(transporter.channel.publish).toHaveBeenCalledTimes(1);
				expect(transporter.channel.publish).toHaveBeenCalledWith(
					"MOL-TEST.INFO",
					"",
					Buffer.from(JSON.stringify({"ver": "2", "sender": "node1"})),
					{}
				);
			});
	});

	it("check publishBalancedEvent", () => {
		const packet = new PacketEvent(fakeTransit, null, "user.created", { id: 5 }, ["mail"]);
		return transporter.publishBalancedEvent(packet, "mail")
			.catch(protectReject).then(() => {
				expect(transporter.channel.sendToQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.sendToQueue).toHaveBeenCalledWith(
					"MOL-TEST.EVENTB.mail.user.created",
					Buffer.from(JSON.stringify({"ver": "2", "sender": "node1", "event": "user.created", "data": { id: 5 }, "groups": ["mail"]})),
					{}
				);
			});

	});

	it("check publishBalancedRequest", () => {
		let ctx = {
			action: { name: "posts.find" },
			params: { a: 5 }
		};
		const packet = new PacketRequest(fakeTransit, null, ctx);
		return transporter.publishBalancedRequest(packet)
			.catch(protectReject).then(() => {
				expect(transporter.channel.sendToQueue).toHaveBeenCalledTimes(1);
				expect(transporter.channel.sendToQueue).toHaveBeenCalledWith(
					"MOL-TEST.REQB.posts.find",
					Buffer.from(JSON.stringify({"ver": "2", "sender": "node1", "action": "posts.find", "params": { a: 5 }})),
					{}
				);
			});

	});

});
