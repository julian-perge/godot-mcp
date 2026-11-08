extends SceneTree
## godot-mcp harness. When run_project or run_scene starts a game, the server
## passes this script to Godot with -s, so it runs as the game's main loop and
## nothing is installed into the project. The project's autoloads and scene load
## as usual, and the harness adds a TCP endpoint on 127.0.0.1 that
## capture_screenshot talks to.
##
## The endpoint only opens in a debug build and only when the server set
## GODOT_MCP_HARNESS_PORT and GODOT_MCP_HARNESS_TOKEN. Each request is one line
## of JSON carrying that token, and the answer is one line of JSON. The harness
## never writes files. Screenshots go back over the socket as base64 PNG.
##
## A screenshot is in the root viewport's own coordinates, the ones node
## positions use. Under stretch mode canvas_items or viewport that is the base
## size from the project settings, whatever the window size or screen density.

const HOST := "127.0.0.1"
const MAX_REQUEST_BYTES := 1048576
const LOG_PREFIX := "[godot-mcp harness] "


class Client:
	var peer: StreamPeerTCP
	var buffer := PackedByteArray()
	var busy := false


var _server: TCPServer = null
var _token := ""
var _clients: Array[Client] = []


func _initialize() -> void:
	# Godot loads the main scene by itself only when no -s script is given.
	if current_scene == null:
		var main_scene := str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if not main_scene.is_empty():
			change_scene_to_file(main_scene)
	if not OS.is_debug_build():
		return
	var port := OS.get_environment("GODOT_MCP_HARNESS_PORT").to_int()
	_token = OS.get_environment("GODOT_MCP_HARNESS_TOKEN")
	if port <= 0 or _token.is_empty():
		return
	_server = TCPServer.new()
	var err := _server.listen(port, HOST)
	if err != OK:
		push_warning(LOG_PREFIX + "could not listen on %s:%d (error %d)" % [HOST, port, err])
		_server = null
		return
	print(LOG_PREFIX + "listening on %s:%d" % [HOST, port])


func _finalize() -> void:
	if _server != null:
		_server.stop()
	for client in _clients:
		client.peer.disconnect_from_host()
	_clients.clear()


func _process(_delta: float) -> bool:
	if _server == null:
		return false
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			var client := Client.new()
			client.peer = peer
			_clients.append(client)
	for client in _clients.duplicate():
		_poll_client(client)
	return false


func _poll_client(client: Client) -> void:
	client.peer.poll()
	var status := client.peer.get_status()
	if status != StreamPeerTCP.STATUS_CONNECTED:
		if status != StreamPeerTCP.STATUS_CONNECTING:
			_clients.erase(client)
		return
	if client.busy:
		return
	var available := client.peer.get_available_bytes()
	if available <= 0:
		return
	var chunk := client.peer.get_data(available)
	if chunk[0] != OK:
		return
	client.buffer = client.buffer + chunk[1]
	var newline := client.buffer.find(10)
	if newline == -1:
		if client.buffer.size() > MAX_REQUEST_BYTES:
			_respond(client, {"ok": false, "error": "request too large"})
		return
	client.busy = true
	_handle_request(client, client.buffer.slice(0, newline).get_string_from_utf8())


func _handle_request(client: Client, line: String) -> void:
	var request = JSON.parse_string(line)
	var response: Dictionary
	if typeof(request) != TYPE_DICTIONARY:
		response = {"ok": false, "error": "request is not a JSON object"}
	elif str(request.get("token", "")) != _token:
		response = {"ok": false, "error": "bad token"}
	elif typeof(request.get("commands")) != TYPE_ARRAY:
		response = {"ok": false, "error": "request has no commands array"}
	else:
		response = await _run_commands(request.commands)
	_respond(client, response)


func _respond(client: Client, response: Dictionary) -> void:
	if client.peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		client.peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())
	client.peer.disconnect_from_host()
	_clients.erase(client)


# Runs the commands in order and stops at the first one that fails, so a
# failed step never leaves the game in a state later steps did not expect.
func _run_commands(commands: Array) -> Dictionary:
	var results := []
	for command in commands:
		var result: Dictionary
		if typeof(command) != TYPE_DICTIONARY:
			result = {"error": "each command must be a JSON object"}
		else:
			result = await _run_command(command)
			result["type"] = str(command.get("type", ""))
		results.append(result)
		if result.has("error"):
			return {"ok": false, "results": results}
	return {"ok": true, "results": results}


func _run_command(command: Dictionary) -> Dictionary:
	match str(command.get("type", "")):
		"screenshot":
			return await _screenshot()
		var other:
			return {"error": "unknown command type: %s" % other}


func _screenshot() -> Dictionary:
	# The headless display server never draws a frame, so waiting for one would hang.
	if DisplayServer.get_name() == "headless":
		return {"error": "the game runs headless, so it draws nothing to capture"}
	# The texture is only complete once the frame has been drawn.
	await RenderingServer.frame_post_draw
	var image := root.get_texture().get_image()
	if image == null or image.is_empty():
		return {"error": "the viewport returned no image"}
	# The texture shows exactly the visible rect, letterbox bars excluded, but
	# under stretch mode canvas_items it has the window's pixel size times the
	# screen scale. Scaling it to the rect's size puts it in node coordinates.
	var size := Vector2i(root.get_visible_rect().size.round())
	if image.get_size() != size:
		image.resize(size.x, size.y, Image.INTERPOLATE_LANCZOS)
	return {
		"width": image.get_width(),
		"height": image.get_height(),
		"png_base64": Marshalls.raw_to_base64(image.save_png_to_buffer()),
	}
