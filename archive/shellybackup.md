# Backing Up Is Hard To Do

This started out with a simple goal to "backup a Shelly device config"; that's unattainable: the Shelly API is simply not designed for it and though you can pull down most config, you can't readily restore a lot of it.

It's preferable to take a declarative approach, i.e. construct and assert the desired state using something like Terraform.
